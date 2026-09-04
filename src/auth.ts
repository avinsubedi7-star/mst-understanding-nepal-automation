import type { Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { sleep } from "./utils.js";

export type AuthenticationState = "authenticated" | "login-required" | "unknown";

export interface AuthenticationSnapshot {
  url: string;
  passwordVisible: boolean;
  subjectsVisible: boolean;
  authenticatedNavigationVisible: boolean;
  unauthenticatedMessageVisible: boolean;
}

const loginPath = /\/(?:login|sign-?in|auth)(?:\/|$|[?#])/i;

export function classifyAuthentication(snapshot: AuthenticationSnapshot): AuthenticationState {
  if (
    loginPath.test(snapshot.url)
    || snapshot.passwordVisible
    || snapshot.unauthenticatedMessageVisible
  ) return "login-required";

  if (
    snapshot.subjectsVisible
    || snapshot.authenticatedNavigationVisible
  ) return "authenticated";

  return "unknown";
}

async function visible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).filter({ visible: true }).first().isVisible().catch(() => false);
}

export async function getAuthenticationState(page: Page): Promise<AuthenticationState> {
  const [passwordVisible, subjectsVisible, authenticatedNavigationVisible, unauthenticatedMessageVisible] = await Promise.all([
    visible(page, 'input[type="password"]'),
    page.getByRole("link", { name: /^Subjects$/i }).filter({ visible: true }).first().isVisible().catch(() => false),
    visible(page, 'a[href*="subject-catalogue"], a[href*="logout"], [data-testid*="dashboard" i]'),
    page.getByText(/session expired|please log in|you must be logged in|unauthorized/i)
      .filter({ visible: true })
      .first()
      .isVisible()
      .catch(() => false),
  ]);

  return classifyAuthentication({
    url: page.url(),
    passwordVisible,
    subjectsVisible,
    authenticatedNavigationVisible,
    unauthenticatedMessageVisible,
  });
}

export async function waitForAuthentication(page: Page, config: AppConfig, logger: Logger): Promise<void> {
  let state = await getAuthenticationState(page);

  // Give a freshly loaded application shell a moment to render before treating an
  // unknown page as an authentication stop.
  if (state === "unknown") {
    const graceDeadline = Date.now() + 5_000;
    while (state === "unknown" && Date.now() < graceDeadline) {
      await sleep(Math.min(config.MST_POLL_INTERVAL_MS, 1_000));
      if (page.isClosed()) throw new Error("Chrome was closed while checking authentication.");
      state = await getAuthenticationState(page);
    }
  }

  if (state === "authenticated") return;

  logger.info("AUTH", "Login required.");
  logger.info("AUTH", "Please log in manually in the opened Chrome window.");
  logger.info("AUTH", "Waiting for successful login...");

  const timeoutMs = config.MST_AUTH_TIMEOUT_MINUTES === 0
    ? undefined
    : config.MST_AUTH_TIMEOUT_MINUTES * 60_000;
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  while (true) {
    if (page.isClosed()) throw new Error("Chrome was closed before login completed.");
    if (await getAuthenticationState(page) === "authenticated") {
      logger.info("AUTH", "Login detected. Continuing automation.");
      return;
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Login was not detected within ${config.MST_AUTH_TIMEOUT_MINUTES} minutes.`);
    }
    await sleep(config.MST_POLL_INTERVAL_MS);
  }
}
