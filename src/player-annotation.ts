import type { Locator, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { saveDiagnostic } from "./diagnostics.js";
import type { Logger } from "./logger.js";
import { sleep } from "./utils.js";

export type PlayerAnnotationKind = "continue" | "retry";

export const PLAYER_ANNOTATION_TEXT: Record<PlayerAnnotationKind, string> = {
  continue: "Click here to continue with this lesson",
  retry: "Click here to retry this question",
};

interface AnnotationVerificationState {
  annotationVisible: boolean;
  quizVisible: boolean;
  beforeTime: number | undefined;
  currentTime: number | undefined;
  paused: boolean | undefined;
}

export function annotationActionSucceeded(
  kind: PlayerAnnotationKind,
  state: AnnotationVerificationState,
): boolean {
  if (kind === "retry") return state.quizVisible;
  const progressed = state.beforeTime !== undefined
    && state.currentTime !== undefined
    && state.currentTime > state.beforeTime + 0.1;
  return !state.annotationVisible && (state.paused === false || progressed);
}

export function playerAnnotationLocator(page: Page, kind: PlayerAnnotationKind): Locator {
  const pattern = kind === "continue"
    ? /Click\s+here\s+to\s+continue\s+with\s+this\s+lesson/i
    : /Click\s+here\s+to\s+retry\s+this\s+question/i;
  return page.getByText(pattern).filter({ visible: true }).first();
}

async function annotationTextLocator(page: Page, kind: PlayerAnnotationKind): Promise<Locator> {
  const text = playerAnnotationLocator(page, kind);
  await text.waitFor({ state: "visible", timeout: 3_000 });
  return text;
}

async function annotationClickTarget(text: Locator): Promise<Locator> {
  const button = text.locator('xpath=ancestor::*[contains(@class, "button-annotation__button")][1]');
  if (await button.count()) return button;
  const container = text.locator('xpath=ancestor::*[contains(@class, "button-annotation__container")][1]');
  if (await container.count()) return container;
  throw new Error("The player annotation text is visible, but its clickable annotation container was not found.");
}

async function moveAwayFromPlayerControls(page: Page): Promise<void> {
  const video = page.locator("video:visible").first();
  const box = await video.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.18);
  } else {
    const viewport = page.viewportSize();
    if (viewport) await page.mouse.move(viewport.width / 2, Math.max(20, viewport.height * 0.15));
  }
  await sleep(2_000);
}

async function videoPlaybackState(page: Page): Promise<{ currentTime: number; paused: boolean } | undefined> {
  const video = page.locator("video:visible").first();
  if (!await video.isVisible().catch(() => false)) return undefined;
  return video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    return { currentTime: media.currentTime, paused: media.paused };
  }).catch(() => undefined);
}

async function verifyAnnotationAction(
  page: Page,
  kind: PlayerAnnotationKind,
  beforeTime: number | undefined,
  timeout = 6_000,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const annotationVisible = await playerAnnotationLocator(page, kind)
      .isVisible()
      .catch(() => false);
    const quizVisible = await page.locator([
      '[role="single"]:visible',
      'label:has(input[type="radio"], input[type="checkbox"]):visible',
      'input[type="radio"]:visible',
      'input[type="checkbox"]:visible',
      '[class*="quiz-annotation__option__"]:visible',
    ].join(", ")).count().catch(() => 0) >= 2;
    const playback = await videoPlaybackState(page);
    if (annotationActionSucceeded(kind, {
      annotationVisible,
      quizVisible,
      beforeTime,
      currentTime: playback?.currentTime,
      paused: playback?.paused,
    })) return true;
    await sleep(250);
  }
  return false;
}

async function domClick(target: Locator): Promise<void> {
  await target.evaluate((element) => (element as HTMLElement).click());
}

export async function clickPlayerAnnotation(
  page: Page,
  kind: PlayerAnnotationKind,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const label = kind === "continue" ? "Continue" : "Retry";
  logger.info("PLAYER", `${label} annotation detected`);
  const before = await videoPlaybackState(page);
  let text = await annotationTextLocator(page, kind);
  let target = await annotationClickTarget(text);

  logger.info("PLAYER", "Attempting annotation click");
  await moveAwayFromPlayerControls(page);
  try {
    await target.click({ timeout: 3_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/intercept(?:s|ed)? pointer events|controlbar/i.test(message)) {
      logger.warn("PLAYER", "Control overlay blocking click; using DOM fallback");
    } else {
      logger.warn("PLAYER", `Normal annotation click failed; using DOM fallback: ${message.split("\n")[0]}`);
    }
    await domClick(target);
  }

  if (await verifyAnnotationAction(page, kind, before?.currentTime)) {
    logger.info("PLAYER", kind === "continue"
      ? "Continue successful; playback resumed"
      : "Retry successful; quiz reopened");
    return;
  }

  await saveDiagnostic(page, config.screenshotsDir, logger, `${kind}-annotation-verification-failed`);
  logger.warn("PLAYER", `${label} verification failed; trying one DOM fallback sequence`);
  await moveAwayFromPlayerControls(page);
  text = await annotationTextLocator(page, kind);
  target = await annotationClickTarget(text);
  await domClick(target);

  if (await verifyAnnotationAction(page, kind, before?.currentTime)) {
    logger.info("PLAYER", kind === "continue"
      ? "Continue successful; playback resumed"
      : "Retry successful; quiz reopened");
    return;
  }

  await saveDiagnostic(page, config.screenshotsDir, logger, `${kind}-annotation-final-failure`);
  throw new Error(`${label} annotation was clicked, but the expected player state did not appear.`);
}
