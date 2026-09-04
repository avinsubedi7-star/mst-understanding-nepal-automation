import { describe, expect, it, vi } from "vitest";
import { prepareAnswerProvider } from "../src/answer-preflight.js";
import type { CodexProcessRunner } from "../src/codex-cli.js";
import { config } from "../src/config.js";

const executablePath = "C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
const logger = { info: vi.fn(), warn: vi.fn() };

function smokeOutput(): string {
  return JSON.stringify({
    answerIndex: 1,
    answerLabel: "B",
    answerText: "2",
    confidence: 1,
    reason: "1 + 1 equals 2.",
    source: "provider",
  });
}

describe("Codex answer-provider startup preflight", () => {
  it("rejects an unauthenticated Codex CLI before the smoke test", async () => {
    const processRunner = vi.fn(async () => ({ stdout: "Not logged in", stderr: "" })) as CodexProcessRunner;
    await expect(prepareAnswerProvider(config, logger, {
      resolveCli: () => ({ executablePath, source: "known-location" }),
      processRunner,
    })).rejects.toThrow(/codex login/iu);
    expect(processRunner).toHaveBeenCalledOnce();
  });

  it("reports a failed provider smoke test", async () => {
    const processRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: "Logged in using ChatGPT", stderr: "" })
      .mockRejectedValueOnce(new Error("structured output failed")) as CodexProcessRunner;
    await expect(prepareAnswerProvider(config, logger, {
      resolveCli: () => ({ executablePath, source: "known-location" }),
      processRunner,
    })).rejects.toThrow(/smoke test failed/iu);
  });

  it("returns a ready Sol/medium provider after authentication and smoke validation", async () => {
    const processRunner = vi.fn()
      .mockResolvedValueOnce({ stdout: "Logged in using ChatGPT", stderr: "" })
      .mockResolvedValueOnce({ stdout: smokeOutput(), stderr: "" }) as CodexProcessRunner;
    const provider = await prepareAnswerProvider(config, logger, {
      resolveCli: () => ({ executablePath, source: "known-location" }),
      processRunner,
    });
    expect(provider.id).toBe("codex-cli:gpt-5.6-sol/medium");
    expect(processRunner).toHaveBeenNthCalledWith(1, executablePath, ["login", "status"], expect.any(Object));
    expect(processRunner).toHaveBeenCalledTimes(2);
    expect(processRunner).toHaveBeenNthCalledWith(
      2,
      executablePath,
      expect.arrayContaining(['model_reasoning_effort="medium"']),
      expect.any(Object),
    );
    expect(processRunner).not.toHaveBeenCalledWith(
      executablePath,
      expect.arrayContaining(['model_reasoning_effort="high"']),
      expect.any(Object),
    );
  });

  it("runs generic CLI preflight only when generic-cli is selected", async () => {
    const genericConfig = {
      ...config,
      MST_ANSWER_PROVIDER: "generic-cli" as const,
      GENERIC_CLI_COMMAND: "agent-cli",
      GENERIC_CLI_ARGS_JSON: ["run", "--json"],
      GENERIC_CLI_IMAGE_ARGS_JSON: [],
      GENERIC_CLI_SUPPORTS_VISION: false,
    };
    const processRunner = vi.fn(async () => ({ stdout: smokeOutput(), stderr: "" })) as CodexProcessRunner;
    const resolveCli = vi.fn(() => ({ executablePath, source: "known-location" as const }));

    const provider = await prepareAnswerProvider(genericConfig, logger, { resolveCli, processRunner });

    expect(provider.id).toBe("generic-cli:default");
    expect(resolveCli).not.toHaveBeenCalled();
    expect(processRunner).toHaveBeenCalledOnce();
    expect(processRunner).toHaveBeenCalledWith("agent-cli", ["run", "--json"], expect.objectContaining({
      input: expect.stringContaining("What is 1 + 1?"),
    }));
  });
});
