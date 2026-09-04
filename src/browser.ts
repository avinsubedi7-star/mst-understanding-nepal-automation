import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(config: AppConfig, logger: Logger): Promise<BrowserSession> {
  fs.mkdirSync(config.profileDir, { recursive: true });
  logger.info("BROWSER", `Opening visible ${config.MST_BROWSER_CHANNEL} with persistent local profile`);
  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: config.MST_BROWSER_CHANNEL,
    chromiumSandbox: true,
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
    timeout: 60_000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(45_000);
  return { context, page };
}
