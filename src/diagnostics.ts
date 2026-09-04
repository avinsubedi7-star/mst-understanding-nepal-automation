import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { Logger } from "./logger.js";

const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 10_000;

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`Diagnostic operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

function safeName(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

export async function saveDiagnostic(
  page: Page,
  screenshotsDir: string,
  logger: Logger,
  label: string,
  target?: Locator,
  timeoutMs = DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
): Promise<string> {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const base = path.join(screenshotsDir, `${stamp}-${safeName(label)}`);
  const saved: string[] = [];
  try {
    const targetVisible = target
      ? await settleWithin(target.isVisible().catch(() => false), Math.min(timeoutMs, 2_000)).catch(() => false)
      : false;
    const screenshot = targetVisible && target
      ? target.screenshot({ path: `${base}.png`, timeout: timeoutMs })
      : page.screenshot({ path: `${base}.png`, fullPage: false, timeout: timeoutMs });
    await settleWithin(screenshot, timeoutMs);
    saved.push(".png");
  } catch (error) {
    logger.warn("DIAG", `Could not save diagnostic screenshot: ${String(error)}`);
  }
  try {
    const bodyText = await settleWithin(
      page.locator("body").innerText({ timeout: Math.min(timeoutMs, 3_000) })
        .catch(() => "[body text unavailable]"),
      Math.min(timeoutMs, 3_500),
    ).catch(() => "[body text unavailable]");
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${bodyText.slice(0, 50_000)}`, "utf8");
    saved.push(".txt");
  } catch (error) {
    logger.warn("DIAG", `Could not save diagnostic text: ${String(error)}`);
  }
  try {
    const dom = await settleWithin(page.content(), Math.min(timeoutMs, 5_000))
      .catch(() => "<!-- DOM unavailable -->");
    fs.writeFileSync(`${base}.html`, dom.slice(0, 500_000), "utf8");
    saved.push(".html");
  } catch (error) {
    logger.warn("DIAG", `Could not save diagnostic HTML: ${String(error)}`);
  }
  if (saved.length) logger.info("DIAG", `Saved ${path.basename(base)}${saved.join(", ")}`);
  return `${base}.png`;
}
