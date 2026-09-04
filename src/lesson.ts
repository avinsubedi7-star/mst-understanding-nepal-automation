import type { Page } from "playwright";
import type { AnswerProvider } from "./answer-provider.js";
import type { AnswerCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import { saveDiagnostic } from "./diagnostics.js";
import type { Logger } from "./logger.js";
import { assertAllowedPage } from "./navigation.js";
import {
  clickQuizProgressButton,
  handlePendingResultOverlay,
  isEndOfLessonQuiz,
  solveActiveQuiz,
  waitForQuiz,
} from "./quiz.js";
import type { VideoState } from "./types.js";
import { formatTime, normalizeText, sleep } from "./utils.js";

export type PlayStartTarget = "initial-overlay" | "player-control" | "video-surface" | "none";

export function choosePlayStartTarget(state: {
  thumbnailOverlayVisible: boolean;
  overlayVisible: boolean;
  accessiblePlayVisible: boolean;
  videoVisible: boolean;
}): PlayStartTarget {
  if (state.thumbnailOverlayVisible || state.overlayVisible) return "initial-overlay";
  if (state.accessiblePlayVisible) return "player-control";
  if (state.videoVisible) return "video-surface";
  return "none";
}

export function playbackStarted(beforeTime: number, state: Pick<VideoState, "currentTime" | "paused">): boolean {
  return !state.paused || state.currentTime > beforeTime + 0.05;
}

async function videoState(page: Page): Promise<VideoState | undefined> {
  const video = page.locator("video:visible").first();
  if (!await video.isVisible().catch(() => false)) return undefined;
  return video.evaluate((element) => {
    const media = element as HTMLVideoElement;
    return {
      currentTime: media.currentTime,
      duration: media.duration,
      paused: media.paused,
      ended: media.ended,
      readyState: media.readyState,
    };
  });
}

async function waitForPlaybackStart(page: Page, beforeTime: number, timeoutMs = 2_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await videoState(page);
    if (state && playbackStarted(beforeTime, state)) return true;
    await sleep(150);
  }
  return false;
}

async function clickNormalPlayControl(page: Page, logger: Logger): Promise<boolean> {
  const video = page.locator("video:visible").first();
  const videoVisible = await video.isVisible().catch(() => false);
  if (!videoVisible) return false;

  const beforeTime = (await videoState(page))?.currentTime ?? 0;
  const thumbnail = page.locator('img[alt="Video Thumbnail"]:visible').first();
  const thumbnailOverlayVisible = await thumbnail.isVisible().catch(() => false);
  const thumbnailOverlay = thumbnail.locator('xpath=ancestor::*[contains(@class, "video-play-overlay")][1]');
  const classOverlay = page.locator('[class*="video-play-overlay"]:visible').first();
  const overlay = thumbnailOverlayVisible && await thumbnailOverlay.isVisible().catch(() => false)
    ? thumbnailOverlay
    : classOverlay;
  const overlayVisible = await overlay.isVisible().catch(() => false);
  const play = page.getByRole("button", { name: /^(play|resume|continue)$/i }).filter({ visible: true }).first();
  const accessiblePlayVisible = await play.isVisible().catch(() => false);

  if (choosePlayStartTarget({ thumbnailOverlayVisible, overlayVisible, accessiblePlayVisible, videoVisible }) === "initial-overlay") {
    logger.info("VIDEO", "Initial play overlay detected");
    try {
      logger.info("VIDEO", "Clicking initial play overlay");
      await overlay.click();
      if (await waitForPlaybackStart(page, beforeTime)) {
        logger.info("VIDEO", "Playback started");
        return true;
      }
      if (!await overlay.isVisible().catch(() => false)) {
        logger.warn("VIDEO", "Initial play overlay disappeared but playback is still paused; trying player Play control");
      }
    } catch (error) {
      logger.warn("VIDEO", `Initial play overlay click did not start playback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (accessiblePlayVisible) {
    try {
      logger.info("VIDEO", "Clicking normal Play control");
      await play.click();
      if (await waitForPlaybackStart(page, beforeTime)) {
        logger.info("VIDEO", "Playback started");
        return true;
      }
    } catch (error) {
      logger.warn("VIDEO", `Normal Play control click did not start playback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    logger.info("VIDEO", "Trying video surface as a final play fallback");
    await video.click({ position: { x: 20, y: 20 } });
    if (await waitForPlaybackStart(page, beforeTime)) {
      logger.info("VIDEO", "Playback started");
      return true;
    }
  } catch (error) {
    logger.warn("VIDEO", `Video surface fallback did not start playback: ${error instanceof Error ? error.message : String(error)}`);
  }

  return false;
}

async function startEndQuiz(page: Page, logger: Logger): Promise<boolean> {
  const prompt = page.getByText(/Take end-of-lesson quiz now to test how good you are/i).filter({ visible: true }).first();
  if (!await prompt.isVisible().catch(() => false)) return false;
  const clickable = prompt.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]');
  if (await clickable.count()) await clickable.click();
  else await prompt.click();
  logger.info("QUIZ", "Starting end-of-lesson quiz");
  return true;
}

async function endQuizFinished(page: Page): Promise<boolean> {
  const text = normalizeText(await page.locator("body").innerText().catch(() => ""));
  return /quiz (completed|complete)|lesson (completed|complete)|congratulations|your score/i.test(text)
    || /Answered\s+(\d+)\s*\/\s*\1/i.test(text)
    || /10\s+out of\s+10/i.test(text);
}

export function extractEndQuizScore(text: string): string | undefined {
  const normalized = normalizeText(text);
  const match = normalized.match(/(?:score|result|marks?)\D{0,30}(\d+)\s*(?:\/|out of)\s*(\d+)/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function logEndQuizScore(page: Page, logger: Logger): Promise<void> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const score = extractEndQuizScore(bodyText);
  if (score) logger.info("QUIZ", `End-of-lesson result: ${score}`);
}

async function closeCompletionDialog(page: Page, logger: Logger): Promise<void> {
  const okay = page.getByRole("button", { name: /^okay$/i }).filter({ visible: true }).first();
  if (await okay.isVisible().catch(() => false)) {
    await okay.click();
    logger.info("QUIZ", "Closed the completion report dialog");
  }
}

export async function completeCurrentLesson(
  page: Page,
  answerProvider: AnswerProvider,
  cache: AnswerCache,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  assertAllowedPage(page);
  const sessionDeadline = Date.now() + config.MST_SESSION_TIMEOUT_MINUTES * 60_000;
  let endQuizMode = false;
  let lastProgressLog = 0;
  let pausedSince = 0;

  logger.info("VIDEO", `Playing: ${normalizeText(await page.title())}`);
  while (Date.now() < sessionDeadline) {
    assertAllowedPage(page);

    const recoveredResult = await handlePendingResultOverlay(page, config, logger);
    if (recoveredResult) {
      await sleep(600);
      continue;
    }

    // The completion report can briefly leave the final question mounted. Check it
    // before waitForQuiz so stale DOM cannot re-enter solveActiveQuiz().
    if (endQuizMode && await endQuizFinished(page)) {
      await logEndQuizScore(page, logger);
      await closeCompletionDialog(page, logger);
      logger.info("QUIZ", "End-of-lesson quiz complete");
      return;
    }

    if (await waitForQuiz(page, 500, logger)) {
      if (!endQuizMode && await isEndOfLessonQuiz(page)) endQuizMode = true;
      await solveActiveQuiz(page, answerProvider, cache, config, logger, endQuizMode ? "end-of-lesson" : "in-lesson");
      await sleep(config.MST_POLL_INTERVAL_MS);
      continue;
    }

    if (endQuizMode) {
      if (await clickQuizProgressButton(page, logger)) {
        await sleep(800);
        continue;
      }
    }

    const state = await videoState(page);
    if (!state) {
      if (await endQuizFinished(page)) return;
      await sleep(config.MST_POLL_INTERVAL_MS);
      continue;
    }

    if (Date.now() - lastProgressLog >= 30_000) {
      logger.info("VIDEO", `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`);
      lastProgressLog = Date.now();
    }

    if (state.ended || (Number.isFinite(state.duration) && state.duration > 0 && state.currentTime >= state.duration - 0.25)) {
      logger.info("VIDEO", "End reached");
      if (await startEndQuiz(page, logger)) endQuizMode = true;
      else if (await endQuizFinished(page)) return;
      await sleep(config.MST_POLL_INTERVAL_MS);
      continue;
    }

    if (state.paused) {
      pausedSince ||= Date.now();
      if (Date.now() - pausedSince > 2500) {
        const resumed = await clickNormalPlayControl(page, logger);
        if (!resumed) {
          await saveDiagnostic(page, config.screenshotsDir, logger, "paused-unexpected-state");
          throw new Error("Video is paused with no quiz and no safe Play control.");
        }
        pausedSince = 0;
      }
    } else {
      pausedSince = 0;
    }
    await sleep(config.MST_POLL_INTERVAL_MS);
  }

  await saveDiagnostic(page, config.screenshotsDir, logger, "session-timeout");
  throw new Error(`Session exceeded ${config.MST_SESSION_TIMEOUT_MINUTES} minutes.`);
}
