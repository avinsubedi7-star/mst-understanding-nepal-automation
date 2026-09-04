import { describe, expect, it, vi } from "vitest";
import type { AnswerRequest } from "../src/answer-provider.js";
import { InconsistentAnswerError } from "../src/answer-provider.js";
import { AutomationPauseError } from "../src/automation-errors.js";
import {
  GenericCliAnswerProvider,
  type GenericCliAnswerProviderOptions,
  UnsupportedProviderCapabilityError,
  validateGenericCliOptions,
} from "../src/generic-cli-answer-provider.js";

const logger = { info: vi.fn(), warn: vi.fn() };
const request: AnswerRequest = {
  quiz: {
    question: "नेपालको राजधानी कुन हो?",
    options: ["पोखरा", "काठमाडौं", "ललितपुर", "भक्तपुर"],
    visual: false,
    completeText: true,
  },
  attemptedAnswerIndexes: [],
};
const options: GenericCliAnswerProviderOptions = {
  command: "agent-cli",
  args: ["run", "--model", "{model}", "--reasoning", "{reasoning}"],
  imageArgs: [],
  supportsVision: false,
  model: "local-model",
  reasoning: "medium",
  timeoutMs: 30_000,
  minimumConfidence: 0.65,
  workingDirectory: process.cwd(),
};

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answerIndex: 1,
    answerLabel: "B",
    answerText: "काठमाडौं",
    confidence: 0.9,
    reason: "काठमाडौं नेपालको राजधानी हो।",
    source: "provider",
    ...overrides,
  });
}

describe("GenericCliAnswerProvider", () => {
  it("uses an executable and argument array, sends the prompt through stdin, and validates the JSON answer", async () => {
    const runner = vi.fn(async () => output());
    const provider = new GenericCliAnswerProvider(options, logger, runner);

    await expect(provider.answer(request)).resolves.toMatchObject({ answerIndex: 1, answerLabel: "B" });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: "agent-cli",
      args: ["run", "--model", "local-model", "--reasoning", "medium"],
      prompt: expect.stringContaining("नेपालको राजधानी"),
    }));
  });

  it("adds the explicit image argument array only for a vision-capable provider", async () => {
    const runner = vi.fn(async () => output());
    const provider = new GenericCliAnswerProvider({
      ...options,
      supportsVision: true,
      imageArgs: ["--image", "{imagePath}"],
    }, logger, runner);

    await provider.answer({ ...request, screenshotPath: "D:\\quiz images\\question.png" });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      args: [...options.args.map((value) => value === "{model}" ? "local-model" : value === "{reasoning}" ? "medium" : value), "--image", "D:\\quiz images\\question.png"],
    }));
  });

  it("pauses before invoking a text-only provider for a visual question", async () => {
    const runner = vi.fn(async () => output());
    const provider = new GenericCliAnswerProvider(options, logger, runner);

    await expect(provider.answer({ ...request, screenshotPath: "question.png" }))
      .rejects.toBeInstanceOf(UnsupportedProviderCapabilityError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects invalid or inconsistent machine output before any browser click can use it", async () => {
    const invalidJson = new GenericCliAnswerProvider(options, logger, vi.fn(async () => "not json"));
    await expect(invalidJson.answer(request)).rejects.toThrow(/JSON answer object/iu);

    const inconsistent = new GenericCliAnswerProvider(
      options,
      logger,
      vi.fn(async () => output({ answerText: "भक्तपुर" })),
    );
    await expect(inconsistent.answer(request)).rejects.toBeInstanceOf(InconsistentAnswerError);
  });

  it("pauses safely when the generic provider reports insufficient confidence", async () => {
    const provider = new GenericCliAnswerProvider(options, logger, vi.fn(async () => output({ confidence: 0.4 })));
    await expect(provider.answer(request)).rejects.toBeInstanceOf(AutomationPauseError);
  });

  it("requires a separate explicit image argument template for vision", () => {
    expect(() => validateGenericCliOptions({ ...options, args: ["--image", "{imagePath}"] }))
      .toThrow(/GENERIC_CLI_IMAGE_ARGS_JSON/);
    expect(() => validateGenericCliOptions({ ...options, supportsVision: true }))
      .toThrow(/include \{imagePath\}/);
  });
});
