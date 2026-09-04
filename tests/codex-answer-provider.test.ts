import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AnswerRequest } from "../src/answer-provider.js";
import { IncompleteCombinationQuestionError } from "../src/answer-provider.js";
import { AutomationPauseError } from "../src/automation-errors.js";
import {
  buildCodexQuizPrompt,
  CodexCliAnswerProvider,
  createCodexRunner,
  parseCodexDecision,
  type CodexAnswerProviderOptions,
} from "../src/codex-answer-provider.js";

const options: CodexAnswerProviderOptions = {
  executablePath: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  timeoutMs: 30_000,
  minimumConfidence: 0.65,
  workingDirectory: process.cwd(),
  outputSchemaPath: "schema.json",
};
const logger = { info: vi.fn(), warn: vi.fn() };
const request: AnswerRequest = {
  quiz: {
    question: "नेपालको राजधानी कुन हो?",
    options: ["पोखरा", "काठमाडौं", "ललितपुर", "भक्तपुर"],
    visual: false,
    completeText: true,
  },
  attemptedAnswerIndexes: [0],
};

function output(answerIndex: number, confidence: number): string {
  return JSON.stringify({
    answerIndex,
    answerLabel: String.fromCharCode(65 + answerIndex),
    answerText: request.quiz.options[answerIndex],
    confidence,
    reason: "काठमाडौं नेपालको राजधानी हो।",
    source: "provider",
  });
}

describe("CodexCliAnswerProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts Medium attempt 1 without escalation", async () => {
    const runner = vi.fn(async () => output(1, 0.98));
    const provider = new CodexCliAnswerProvider(options, logger, runner);
    await expect(provider.answer(request)).resolves.toMatchObject({ answerIndex: 1, answerLabel: "B" });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "medium" }));
  });

  it("accepts Medium attempt 2 without a High call", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.88));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await expect(provider.answer(request)).resolves.toMatchObject({ answerIndex: 1, confidence: 0.88 });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map((call) => call[0].reasoningEffort)).toEqual(["medium", "medium"]);
  });

  it("calls exactly one High attempt after both Medium attempts remain low", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.62))
      .mockResolvedValueOnce(output(1, 0.59));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await expect(provider.answer(request)).rejects.toBeInstanceOf(AutomationPauseError);
    expect(runner.mock.calls.map((call) => call[0].reasoningEffort)).toEqual(["medium", "medium", "high"]);
  });

  it("accepts a confident answer from the single High escalation", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.62))
      .mockResolvedValueOnce(output(1, 0.88));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await expect(provider.answer(request)).resolves.toMatchObject({ answerIndex: 1, confidence: 0.88 });
    expect(logger.info).toHaveBeenCalledWith("ANSWER", "Escalating difficult question to Sol/high");
    expect(logger.info).toHaveBeenCalledWith("ANSWER", "Sol/high selected B (confidence 0.88)");
  });

  it("pauses safely when High remains below the threshold", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.62))
      .mockResolvedValueOnce(output(1, 0.59));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await expect(provider.answer(request)).rejects.toBeInstanceOf(AutomationPauseError);
    expect(logger.warn).toHaveBeenCalledWith("ANSWER", "Sol/high confidence 0.59 remains below 0.65");
    expect(logger.warn).toHaveBeenCalledWith("PAUSE", "Unable to answer safely after adaptive reasoning escalation");
  });

  it("excludes known-wrong options from the High escalation prompt", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.62))
      .mockResolvedValueOnce(output(1, 0.88));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await provider.answer(request);
    expect(runner.mock.calls[2]?.[0].prompt).toContain("Never select a known-wrong choice: A (0)");
    expect(runner.mock.calls[2]?.[0].prompt).toContain("Solve independently");
  });

  it("retries an invalid known-wrong choice and accepts a safe replacement", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(0, 0.95))
      .mockResolvedValueOnce(output(1, 0.9));
    const provider = new CodexCliAnswerProvider(options, logger, runner);
    await expect(provider.answer(request)).resolves.toMatchObject({ answerIndex: 1 });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("rejects a label/text mismatch, retries once, and never exposes the inconsistent answer", async () => {
    const inconsistent = JSON.stringify({
      answerIndex: 2,
      answerLabel: "C",
      answerText: "भक्तपुर",
      confidence: 0.99,
      reason: "The answer text is भक्तपुर, which is D.",
      source: "provider",
    });
    const runner = vi.fn()
      .mockResolvedValueOnce(inconsistent)
      .mockResolvedValueOnce(output(1, 0.97));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    const decision = await provider.answer(request);

    expect(decision).toMatchObject({ answerIndex: 1, answerLabel: "B", answerText: "काठमाडौं" });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("ANSWER", "Inconsistent Codex answer detected; retrying");
    expect(runner.mock.calls[1]?.[0].prompt).toContain("index/label/text mismatch");
  });

  it("applies consistency validation to the High result and never yields it", async () => {
    const inconsistent = JSON.stringify({
      answerIndex: 2,
      answerLabel: "C",
      answerText: "भक्तपुर",
      confidence: 0.99,
      reason: "The text maps to D, not C.",
      source: "provider",
    });
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.4))
      .mockResolvedValueOnce(output(1, 0.5))
      .mockResolvedValueOnce(inconsistent);
    const provider = new CodexCliAnswerProvider(options, logger, runner);
    const click = vi.fn();

    await expect(provider.answer(request).then(click)).rejects.toBeInstanceOf(AutomationPauseError);
    expect(click).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith("ANSWER", "Inconsistent Sol/high answer detected; pausing without clicking");
  });

  it("logs low confidence after the final Medium attempt without claiming another Medium retry", async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(output(1, 0.45))
      .mockResolvedValueOnce(output(1, 0.62))
      .mockResolvedValueOnce(output(1, 0.88));
    const provider = new CodexCliAnswerProvider(options, logger, runner);

    await provider.answer(request);
    expect(logger.info).toHaveBeenCalledWith("ANSWER", "Sol/medium attempt 2/2");
    expect(logger.warn).toHaveBeenCalledWith("ANSWER", "Low confidence: 0.62");
    expect(logger.warn).not.toHaveBeenCalledWith("ANSWER", expect.stringContaining("reasoning again once"));
  });
});

describe("Codex answer formatting", () => {
  it("uses an API-compatible type declaration for every output property", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "codex-answer-schema.json"), "utf8")) as {
      properties: Record<string, { type?: string }>;
    };
    expect(Object.values(schema.properties).every((property) => typeof property.type === "string")).toBe(true);
  });

  it("includes known-wrong choices and visual instructions in the prompt", () => {
    const prompt = buildCodexQuizPrompt({
      ...request,
      screenshotPath: "quiz.png",
      lessonContext: "Unit 4 | ४.७ - मध्यकाल (भाग २)",
    }, 0.65);
    expect(prompt).toContain("A (0)");
    expect(prompt).toContain("screenshot");
    expect(prompt).toContain("नेपालको राजधानी");
    expect(prompt).toContain("Lesson context: Unit 4 | ४.७ - मध्यकाल (भाग २)");
    expect(prompt).toContain("answerIndex, answerLabel, and answerText");
  });

  it("formats a DOM-complete combination question with a structured statement list", () => {
    const prompt = buildCodexQuizPrompt({
      ...request,
      quiz: {
        ...request.quiz,
        question: "नेपाल र अङ्ग्रेज बिच के कारणले गर्दा युद्ध सुरु भएको थियो ?",
        options: ["I र IV", "I, III र IV", "I, II र III", "I, II, III र IV"],
        combination: {
          referencedLabels: ["I", "II", "III", "IV"],
          statements: [
            { label: "I", text: "बुटवलको जमिन" },
            { label: "II", text: "पाल्पा र स्युराजको जमिन" },
            { label: "III", text: "व्यापार" },
            { label: "IV", text: "नेपालमा भइरहेको औद्योगिक विकास" },
          ],
          requiresVisual: false,
        },
      },
    }, 0.65);
    expect(prompt).toContain("Statements:");
    expect(prompt).toContain("I. बुटवलको जमिन");
    expect(prompt).toContain("IV. नेपालमा भइरहेको औद्योगिक विकास");
    expect(prompt).toContain("Evaluate every labelled statement");
  });

  it("requires visual reading when a combination statement list is absent from DOM", () => {
    const prompt = buildCodexQuizPrompt({
      ...request,
      screenshotPath: "combination-question.png",
      quiz: {
        ...request.quiz,
        options: ["I र IV", "I, III र IV", "I, II र III", "I, II, III र IV"],
        combination: {
          referencedLabels: ["I", "II", "III", "IV"],
          statements: [],
          requiresVisual: true,
        },
      },
    }, 0.65);
    expect(prompt).toContain("Read every labelled statement from the attached quiz screenshot");
    expect(prompt).toContain("do not answer from the combinations alone");
    expect(prompt).toContain("[Read the labelled statements from the attached screenshot.]");
  });

  it("does not call the provider text-only when a combination statement list is incomplete", async () => {
    const runner = vi.fn(async () => output(1, 0.99));
    const provider = new CodexCliAnswerProvider(options, logger, runner);
    const incomplete: AnswerRequest = {
      ...request,
      quiz: {
        ...request.quiz,
        options: ["I र IV", "I, III र IV", "I, II र III", "I, II, III र IV"],
        combination: {
          referencedLabels: ["I", "II", "III", "IV"],
          statements: [],
          requiresVisual: true,
        },
      },
    };
    await expect(provider.answer(incomplete)).rejects.toBeInstanceOf(IncompleteCombinationQuestionError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("sends a complete structured combination question to the provider", async () => {
    const runner = vi.fn(async () => output(1, 0.99));
    const provider = new CodexCliAnswerProvider(options, logger, runner);
    const complete: AnswerRequest = {
      ...request,
      quiz: {
        ...request.quiz,
        combination: {
          referencedLabels: ["I", "II"],
          statements: [
            { label: "I", text: "पहिलो कथन" },
            { label: "II", text: "दोस्रो कथन" },
          ],
          requiresVisual: false,
        },
      },
    };
    await expect(provider.answer(complete)).resolves.toMatchObject({ answerIndex: 1 });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("I. पहिलो कथन"),
    }));
  });

  it("parses a schema-shaped JSON response", () => {
    expect(parseCodexDecision(output(1, 0.9))).toMatchObject({ answerIndex: 1, confidence: 0.9 });
  });

  it("passes a per-call High reasoning override to Codex CLI", async () => {
    const processRunner = vi.fn(async () => ({ stdout: output(1, 0.9), stderr: "" }));
    const runner = createCodexRunner(options, processRunner);
    await runner({ prompt: "quiz", reasoningEffort: "high" });
    expect(processRunner).toHaveBeenCalledWith(
      options.executablePath,
      expect.arrayContaining(['model_reasoning_effort="high"']),
      expect.any(Object),
    );
  });
});
