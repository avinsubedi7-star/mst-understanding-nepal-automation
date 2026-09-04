import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { prepareAnswerProvider } from "./answer-preflight.js";
import { waitForAuthentication } from "./auth.js";
import { AutomationPauseError } from "./automation-errors.js";
import { launchBrowser } from "./browser.js";
import { AnswerCache } from "./cache.js";
import { config } from "./config.js";
import { saveDiagnostic } from "./diagnostics.js";
import { completeCurrentLesson } from "./lesson.js";
import { Logger } from "./logger.js";
import { findNextIncompleteVideo, openNextVideo, openStartPage } from "./navigation.js";

export interface MainDependencies {
  prepareAnswerProvider: typeof prepareAnswerProvider;
  launchBrowser: typeof launchBrowser;
  waitForAuthentication: typeof waitForAuthentication;
  openStartPage: typeof openStartPage;
  findNextIncompleteVideo: typeof findNextIncompleteVideo;
  completeCurrentLesson: typeof completeCurrentLesson;
  openNextVideo: typeof openNextVideo;
}

const defaultDependencies: MainDependencies = {
  prepareAnswerProvider,
  launchBrowser,
  waitForAuthentication,
  openStartPage,
  findNextIncompleteVideo,
  completeCurrentLesson,
  openNextVideo,
};

async function openAuthenticationProbe(page: Page, logger: Logger): Promise<void> {
  const target = new URL(config.MST_START_URL);
  if (target.hostname !== "app.mysecondteacher.com.np") {
    throw new Error("MST_START_URL must use app.mysecondteacher.com.np.");
  }
  logger.info("AUTH", "Checking authentication...");
  await page.goto(new URL("/", target).href, { waitUntil: "domcontentloaded" });
}

function logNoIncompleteVideos(logger: Logger, message: string): void {
  logger.info("DONE", "No incomplete Social Studies videos remain.");
  logger.info("DONE", message);
  logger.info("APP", "Exiting automation.");
}

export async function main(overrides: Partial<MainDependencies> = {}): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const logger = new Logger(config.logsDir, config.LOG_LEVEL);
  const cache = new AnswerCache(config.cachePath);
  let answerProvider;
  try {
    answerProvider = await dependencies.prepareAnswerProvider(config, logger);
  } catch (error) {
    logger.error("PRECHECK", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  logger.info("ANSWER", `Provider: ${answerProvider.id}`);
  const { context, page } = await dependencies.launchBrowser(config, logger);
  let stopping = false;
  let authenticationComplete = false;

  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("APP", `Stopping safely after ${signal}`);
    await context.close().catch(() => undefined);
  };
  const handleSigint = (): void => { void stop("Ctrl+C"); };
  const handleSigterm = (): void => { void stop("termination signal"); };
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await openAuthenticationProbe(page, logger);
    await dependencies.waitForAuthentication(page, config, logger);
    authenticationComplete = true;

    if (config.MST_DISCOVER_FROM_CATALOGUE && !await dependencies.findNextIncompleteVideo(page, config, logger)) {
      logNoIncompleteVideos(logger, "Nothing to do.");
      process.exitCode = 0;
      return;
    }
    if (!config.MST_DISCOVER_FROM_CATALOGUE) await dependencies.openStartPage(page, config, logger);

    let completedLessons = 0;
    while (!stopping) {
      await dependencies.completeCurrentLesson(page, answerProvider, cache, config, logger);
      completedLessons += 1;
      logger.info("APP", `Completed lessons this run: ${completedLessons}`);
      if (!await dependencies.openNextVideo(page, config, logger)
        && !await dependencies.findNextIncompleteVideo(page, config, logger)) {
        logNoIncompleteVideos(logger, "All required lessons are complete.");
        process.exitCode = 0;
        break;
      }
    }
  } catch (error) {
    logger.error("ERROR", error instanceof Error ? error.stack ?? error.message : String(error));
    await saveDiagnostic(page, config.screenshotsDir, logger, "fatal-error").catch(() => undefined);
    process.exitCode = 1;
    const pauseRequested = error instanceof AutomationPauseError;
    if ((!authenticationComplete || pauseRequested) && !stopping && !page.isClosed()) {
      logger.warn(pauseRequested ? "PAUSE" : "AUTH", pauseRequested
        ? "Automation paused safely on the current quiz; no answer was clicked."
        : "Initial authentication failed. Chrome will remain open for inspection.");
      logger.warn(pauseRequested ? "PAUSE" : "AUTH", "Close Chrome or press Ctrl+C in this terminal when you are finished inspecting it.");
      await context.waitForEvent("close").catch(() => undefined);
    }
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    await context.close().catch(() => undefined);
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) void main();
