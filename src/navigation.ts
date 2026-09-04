import type { Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { normalizeText, sleep } from "./utils.js";

const allowedHost = "app.mysecondteacher.com.np";

export function assertAllowedPage(page: Page): void {
  const url = new URL(page.url());
  if (url.hostname !== allowedHost) throw new Error(`Refusing to automate outside ${allowedHost}: ${url.hostname}`);
}

export async function openStartPage(page: Page, config: AppConfig, logger: Logger): Promise<void> {
  const target = new URL(config.MST_START_URL);
  if (target.hostname !== allowedHost) throw new Error("MST_START_URL must use app.mysecondteacher.com.np.");
  logger.info("NAV", "Opening configured Social Studies lesson");
  await page.goto(target.href, { waitUntil: "domcontentloaded" });
}

export async function openNextVideo(page: Page, config: AppConfig, logger: Logger): Promise<boolean> {
  assertAllowedPage(page);
  const nextById = page.locator("#video-next-to-watch:visible").first();
  if (await nextById.isVisible().catch(() => false)) {
    const card = nextById.locator('xpath=ancestor-or-self::*[@role="presentation" or self::a or self::button][1]');
    const target = await card.count() ? card : nextById;
    const title = normalizeText(await target.innerText().catch(() => "next video"));
    if (!/N\/?A/i.test(title)) {
      logger.info("NAV", "Adjacent next video is already complete; switching to catalogue discovery");
      return false;
    }
    logger.info("NAV", `Opening next video: ${title.slice(0, 120)}`);
    await Promise.all([
      page.waitForURL((url) => url.hostname === allowedHost, { timeout: 30_000 }).catch(() => undefined),
      target.click(),
    ]);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return true;
  }

  const nextLinks = page.locator('a[href*="/videos/"]:visible, [role="presentation"]:visible');
  const count = Math.min(await nextLinks.count(), 100);
  for (let index = 0; index < count; index += 1) {
    const candidate = nextLinks.nth(index);
    const text = normalizeText(await candidate.innerText().catch(() => ""));
    const classes = await candidate.getAttribute("class") ?? "";
    const completed = /completed|watched|done|100%|mastered|adequate|proficient|developing/i.test(`${text} ${classes}`);
    const locked = /locked|disabled/i.test(classes) || await candidate.getAttribute("aria-disabled") === "true";
    if (!completed && !locked && /next|continue|watch|lesson|video/i.test(text)) {
      logger.info("NAV", `Opening discovered incomplete video: ${text.slice(0, 120)}`);
      await candidate.click();
      await sleep(1000);
      return true;
    }
  }

  logger.info("NAV", `No safe next-video control was found for ${config.MST_SUBJECT_NAME}`);
  return false;
}

export async function findNextIncompleteVideo(page: Page, config: AppConfig, logger: Logger): Promise<boolean> {
  assertAllowedPage(page);
  const configuredPath = new URL(config.MST_START_URL).pathname;
  const subjectId = configuredPath.match(/\/subjects\/(\d+)/)?.[1];
  if (!subjectId) {
    throw new Error(
      "MST_START_URL must be set to an authorized My Second Teacher lesson URL containing /subjects/<subject-id>/ before catalogue discovery can run.",
    );
  }

  if (!new RegExp(`/subjects/${subjectId}/chapters/\\d+/ivy`).test(new URL(page.url()).pathname)) {
    const subjectsLink = page.getByRole("link", { name: /^Subjects$/i }).filter({ visible: true }).first();
    await subjectsLink.click();
    await page.waitForURL((url) => url.hostname === allowedHost && url.pathname.includes("/subject-catalogue/"), { timeout: 30_000 });
    const subjectTitle = page.getByText(config.MST_SUBJECT_NAME, { exact: true }).filter({ visible: true }).first();
    await subjectTitle.waitFor({ state: "visible", timeout: 30_000 });
    const subjectCard = subjectTitle.locator('xpath=ancestor::*[@role="presentation"][1]');
    await subjectCard.click();
    await page.waitForURL((url) => new RegExp(`/subjects/${subjectId}/chapters/\\d+/ivy`).test(url.pathname), { timeout: 30_000 });
  }

  const unitHeaders = page.locator(".list-group__header:visible");
  await unitHeaders.first().waitFor({ state: "visible", timeout: 30_000 });
  const unitCount = await unitHeaders.count();
  for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
    const header = unitHeaders.nth(unitIndex);
    const headerText = normalizeText(await header.innerText());
    const videoCompletion = Number(headerText.match(/(\d+)%/)?.[1] ?? "0");
    if (videoCompletion >= 100) continue;

    logger.info("NAV", `Inspecting incomplete ${headerText.replace(/\d+%.*$/, "").trim()}`);
    if (!/\bactive\b/i.test(await header.getAttribute("class") ?? "")) {
      await header.click();
      await sleep(600);
    }
    const cards = page.locator('section:visible .card-deck [role="presentation"]:visible');
    const cardCount = await cards.count();
    for (let cardIndex = 0; cardIndex < cardCount; cardIndex += 1) {
      const card = cards.nth(cardIndex);
      const cardText = normalizeText(await card.innerText());
      if (!/N\/?A/i.test(cardText)) continue;
      const title = normalizeText(await card.locator("h4").innerText().catch(() => cardText));
      logger.info("NAV", `Opening incomplete video from catalogue: ${title}`);
      await card.click();
      await page.waitForURL((url) => url.hostname === allowedHost && url.pathname.includes("/videos/"), { timeout: 30_000 });
      return true;
    }
  }

  logger.info("NAV", `All catalogue videos for ${config.MST_SUBJECT_NAME} appear complete`);
  return false;
}
