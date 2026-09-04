import type { BrowserContext, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import type { AnswerProvider } from "../src/answer-provider.js";
import { main } from "../src/index.js";

const answerProvider = {
  id: "test-provider",
  answer: vi.fn(),
} as unknown as AnswerProvider;

describe("startup authentication gate", () => {
  it("does not discover videos after a /login redirect until authentication resolves", async () => {
    let currentUrl = "about:blank";
    let resolveAuthentication: (() => void) | undefined;
    const authenticationGate = new Promise<void>((resolve) => {
      resolveAuthentication = resolve;
    });

    const page = {
      goto: vi.fn(async () => {
        currentUrl = "https://app.mysecondteacher.com.np/login";
      }),
      url: vi.fn(() => currentUrl),
      isClosed: vi.fn(() => false),
    } as unknown as Page;
    const context = {
      close: vi.fn(async () => undefined),
      waitForEvent: vi.fn(async () => undefined),
    } as unknown as BrowserContext;

    const waitForAuthentication = vi.fn(async () => authenticationGate);
    const openStartPage = vi.fn(async () => undefined);
    const findNextIncompleteVideo = vi.fn(async () => false);

    const run = main({
      prepareAnswerProvider: vi.fn(async () => answerProvider),
      launchBrowser: vi.fn(async () => ({ context, page })),
      waitForAuthentication,
      openStartPage,
      findNextIncompleteVideo,
    });

    await vi.waitFor(() => expect(waitForAuthentication).toHaveBeenCalledOnce());
    expect(page.url()).toContain("/login");
    expect(openStartPage).not.toHaveBeenCalled();
    expect(findNextIncompleteVideo).not.toHaveBeenCalled();

    resolveAuthentication?.();
    await run;

    expect(findNextIncompleteVideo).toHaveBeenCalledOnce();
    expect(openStartPage).not.toHaveBeenCalled();
  });

  it("exits cleanly without opening a lesson when every catalogue video is complete", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://app.mysecondteacher.com.np/"),
      isClosed: vi.fn(() => false),
    } as unknown as Page;
    const context = {
      close: vi.fn(async () => undefined),
      waitForEvent: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    const openStartPage = vi.fn(async () => undefined);
    const completeCurrentLesson = vi.fn(async () => undefined);
    const findNextIncompleteVideo = vi.fn(async () => false);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main({
      prepareAnswerProvider: vi.fn(async () => answerProvider),
      launchBrowser: vi.fn(async () => ({ context, page })),
      waitForAuthentication: vi.fn(async () => undefined),
      openStartPage,
      completeCurrentLesson,
      findNextIncompleteVideo,
    });

    expect(findNextIncompleteVideo).toHaveBeenCalledOnce();
    expect(openStartPage).not.toHaveBeenCalled();
    expect(completeCurrentLesson).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("[DONE] No incomplete Social Studies videos remain.");
    expect(output).toHaveBeenCalledWith("[DONE] Nothing to do.");
    expect(output.mock.calls.filter(([line]) => line === "[DONE] No incomplete Social Studies videos remain.")).toHaveLength(1);
    expect(process.exitCode).toBe(0);
    output.mockRestore();
    process.exitCode = previousExitCode;
  });

  it("exits after the final completed lesson when no incomplete video remains", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://app.mysecondteacher.com.np/"),
      isClosed: vi.fn(() => false),
    } as unknown as Page;
    const context = {
      close: vi.fn(async () => undefined),
      waitForEvent: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    const completeCurrentLesson = vi.fn(async () => undefined);
    const findNextIncompleteVideo = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main({
      prepareAnswerProvider: vi.fn(async () => answerProvider),
      launchBrowser: vi.fn(async () => ({ context, page })),
      waitForAuthentication: vi.fn(async () => undefined),
      completeCurrentLesson,
      openNextVideo: vi.fn(async () => false),
      findNextIncompleteVideo,
    });

    expect(completeCurrentLesson).toHaveBeenCalledOnce();
    expect(findNextIncompleteVideo).toHaveBeenCalledTimes(2);
    expect(output).toHaveBeenCalledWith("[DONE] All required lessons are complete.");
    expect(context.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    output.mockRestore();
    process.exitCode = previousExitCode;
  });

  it("continues to a discovered incomplete video after a completed lesson", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://app.mysecondteacher.com.np/"),
      isClosed: vi.fn(() => false),
    } as unknown as Page;
    const context = {
      close: vi.fn(async () => undefined),
      waitForEvent: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    const completeCurrentLesson = vi.fn(async () => undefined);
    const findNextIncompleteVideo = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await main({
      prepareAnswerProvider: vi.fn(async () => answerProvider),
      launchBrowser: vi.fn(async () => ({ context, page })),
      waitForAuthentication: vi.fn(async () => undefined),
      completeCurrentLesson,
      openNextVideo: vi.fn(async () => false),
      findNextIncompleteVideo,
    });

    expect(completeCurrentLesson).toHaveBeenCalledTimes(2);
    expect(findNextIncompleteVideo).toHaveBeenCalledTimes(3);
    expect(context.close).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    process.exitCode = previousExitCode;
  });

  it("does not launch Playwright when the Codex startup preflight fails", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const launchBrowser = vi.fn();

    await main({
      prepareAnswerProvider: vi.fn(async () => { throw new Error("Codex CLI was not found."); }),
      launchBrowser,
    });

    expect(launchBrowser).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
