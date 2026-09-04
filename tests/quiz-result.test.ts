import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { AutomationPauseError } from "../src/automation-errors.js";
import {
  captureQuizScreenshot,
  chooseAnswerOptionStrategy,
  classifyQuizEvidence,
  classifyPostSubmitObservation,
  detectCombinationQuestion,
  extractQuizWithRetry,
  fingerprintQuizSnapshot,
  observePostSubmitState,
  observePostSubmitStateWithProbe,
  pauseAfterQuizStageFailure,
  POST_SUBMIT_CANDIDATE_STATES,
  QuizStageTimeoutError,
  quizQuestionFromSnapshot,
  formatCombinationStatements,
  quizFingerprintChanged,
  readQuizDomSnapshot,
  selectQuestionText,
  tryGetQuizFingerprint,
  withStageTimeout,
  type PostSubmitProbeResult,
  type QuizDomSnapshot,
  type PostSubmitObservation,
} from "../src/quiz.js";

const requestOptions = ["पृथ्वीनारायण शाह", "जयप्रकाश मल्ल", "सिद्दीनरसिंह मल्ल", "रणजित मल्ल"];

const oldQuestionSnapshot: QuizDomSnapshot = {
  options: ["A", "B", "C", "D"],
  preferredTexts: ["Old question?"],
  panelText: "Question 1 out of 10\nOld question?\nA\nB\nC\nD",
  counter: "Question 1 out of 10",
  containerPresent: true,
  meaningfulVisual: false,
};
const oldQuestion = fingerprintQuizSnapshot(oldQuestionSnapshot)!;

function probeResult(overrides: Partial<PostSubmitProbeResult> = {}): PostSubmitProbeResult {
  return {
    continueVisible: false,
    retryVisible: false,
    correctMarkerVisible: false,
    incorrectMarkerVisible: false,
    completionVisible: false,
    progressControlVisible: false,
    playbackResumed: false,
    quiz: { optionCount: 0, containerPresent: false },
    ...overrides,
  };
}

async function observeSequence(states: readonly PostSubmitProbeResult[]) {
  let elapsed = 0;
  let index = 0;
  const probe = vi.fn(async () => states[Math.min(index++, states.length - 1)]!);
  const logger = { info: vi.fn() };
  const result = await observePostSubmitStateWithProbe(oldQuestion, 30_000, logger, probe, {
    now: () => elapsed,
    sleep: async (milliseconds) => { elapsed += milliseconds; },
  });
  return { result, probe, logger };
}

function observation(overrides: Partial<PostSubmitObservation> = {}): PostSubmitObservation {
  return {
    continueVisible: false,
    retryVisible: false,
    correctMarkerVisible: false,
    incorrectMarkerVisible: false,
    nextQuestionVisible: false,
    completionVisible: false,
    progressControlVisible: false,
    playbackResumed: false,
    ...overrides,
  };
}

describe("post-submit quiz result classification", () => {
  it("recognizes the continue annotation shown in the saved live diagnostic", () => {
    const diagnosticText = "Click here to continue with this lesson";
    expect(diagnosticText).toMatch(/continue with this lesson/i);
    expect(classifyPostSubmitObservation(observation({ continueVisible: true }))).toBe("correct");
  });

  it("recognizes retry, next-question, completion, and resumed-playback transitions", () => {
    expect(classifyPostSubmitObservation(observation({ retryVisible: true }))).toBe("incorrect");
    expect(classifyPostSubmitObservation(observation({ nextQuestionVisible: true }))).toBe("advanced");
    expect(classifyPostSubmitObservation(observation({ completionVisible: true }))).toBe("completed");
    expect(classifyPostSubmitObservation(observation({ playbackResumed: true }))).toBe("advanced");
  });

  it("observes bare result markers without confusing them with actionable annotations", () => {
    expect(classifyPostSubmitObservation(observation({ correctMarkerVisible: true }))).toBe("unknown");
    expect(classifyPostSubmitObservation(observation({ incorrectMarkerVisible: true }))).toBe("unknown");
  });

  it("reports every candidate checked when no state is recognized", () => {
    expect(classifyPostSubmitObservation(observation())).toBe("unknown");
    expect(POST_SUBMIT_CANDIDATE_STATES).toContain("continue annotation");
    expect(POST_SUBMIT_CANDIDATE_STATES).toContain("end-of-lesson completion/result");
  });
});

describe("transition-safe quiz snapshots", () => {
  const previousSnapshot = oldQuestionSnapshot;
  const previous = oldQuestion;

  it("treats zero or one temporarily visible option as an incomplete transition", () => {
    expect(fingerprintQuizSnapshot({
      ...previousSnapshot,
      options: [],
      panelText: "",
    })).toBeUndefined();
    expect(fingerprintQuizSnapshot({
      ...previousSnapshot,
      options: ["A"],
    })).toBeUndefined();
  });

  it("allows Continue or Retry to appear after the old options disappear", () => {
    const disappeared = fingerprintQuizSnapshot({
      options: [],
      preferredTexts: [],
      panelText: "",
      containerPresent: false,
      meaningfulVisual: false,
    });
    expect(quizFingerprintChanged(previous, disappeared)).toBe(false);
    expect(classifyPostSubmitObservation(observation({ continueVisible: true }))).toBe("correct");
    expect(classifyPostSubmitObservation(observation({ retryVisible: true }))).toBe("incorrect");
  });

  it("detects a replacement question without reading stale old option locators", () => {
    const replacement = fingerprintQuizSnapshot({
      options: ["W", "X", "Y", "Z"],
      preferredTexts: ["New question?"],
      panelText: "Question 2 out of 10\nNew question?\nW\nX\nY\nZ",
      counter: "Question 2 out of 10",
      containerPresent: true,
      meaningfulVisual: false,
    });
    expect(quizFingerprintChanged(previous, replacement)).toBe(true);
  });

  it("recognizes completion after the final answer even with no options", () => {
    expect(classifyPostSubmitObservation(observation({ completionVisible: true }))).toBe("completed");
  });

  it("uses immediate locator batches without locator.innerText auto-waits", () => {
    const source = readQuizDomSnapshot.toString();
    expect(source).toContain("findVisibleAnswerOptions");
    expect(source).toContain("allInnerTexts");
    expect(source).not.toContain(".innerText(");
    expect(source).not.toContain("document.querySelectorAll");
  });

  it("returns null-like fingerprint state immediately for zero disappearing options", async () => {
    const evaluate = vi.fn(async () => ({
      options: [],
      preferredTexts: [],
      panelText: "",
      containerPresent: false,
      meaningfulVisual: false,
    }));
    const page = { evaluate } as unknown as Page;
    await expect(tryGetQuizFingerprint(page)).resolves.toEqual({ optionCount: 0, containerPresent: false });
  });
});

describe("bounded pre-submit quiz processing", () => {
  const page = {} as Page;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const completeQuiz = {
    question: "नेपालको राजधानी कुन हो?",
    options: ["काठमाडौं", "पोखरा", "जनकपुर", "ललितपुर"],
    visual: false,
    completeText: true,
  };
  const quickPolicy = {
    attempts: 3,
    attemptTimeoutMs: 50,
    retryDelayMs: 0,
    minimumOptionCount: 2,
    maximumOptionCount: 6,
  };

  it("bounds a stage whose underlying operation never settles", async () => {
    await expect(withStageTimeout(
      "test quiz stage",
      10,
      () => new Promise<never>(() => undefined),
    )).rejects.toEqual(expect.objectContaining({
      name: "QuizStageTimeoutError",
      stage: "test quiz stage",
      timeoutMs: 10,
    }));
  });

  it("stops after bounded retries when quiz options never finish rendering", async () => {
    const extract = vi.fn(async () => ({ ...completeQuiz, options: completeQuiz.options.slice(0, 1) }));
    await expect(extractQuizWithRetry(page, logger, "QUIZ:q-test", quickPolicy, {
      extract,
      sleep: async () => undefined,
    })).rejects.toThrow(/failed after 3 bounded attempts/i);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("retries the whole extraction when only one option has rendered", async () => {
    const extract = vi.fn()
      .mockResolvedValueOnce({ ...completeQuiz, options: completeQuiz.options.slice(0, 1) })
      .mockResolvedValueOnce(completeQuiz);
    await expect(extractQuizWithRetry(page, logger, "QUIZ:q-test", quickPolicy, {
      extract,
      sleep: async () => undefined,
    })).resolves.toEqual(completeQuiz);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("retries from a fresh snapshot when MathJax option text appears late", async () => {
    const extract = vi.fn()
      .mockResolvedValueOnce({ ...completeQuiz, options: ["काठमाडौं", "जनकपुर", "ललितपुर"], optionTargetCount: 4 })
      .mockResolvedValueOnce(completeQuiz);
    await expect(extractQuizWithRetry(page, logger, "QUIZ:q-test", quickPolicy, {
      extract,
      sleep: async () => undefined,
    })).resolves.toEqual(completeQuiz);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("preserves readable DOM question text when a quiz also has a visual", async () => {
    const snapshot: QuizDomSnapshot = {
      options: completeQuiz.options,
      preferredTexts: [completeQuiz.question],
      panelText: `${completeQuiz.question}\n${completeQuiz.options.join("\n")}`,
      containerPresent: true,
      meaningfulVisual: true,
      optionTargetCount: 4,
    };
    expect(quizQuestionFromSnapshot(snapshot)).toMatchObject({
      question: completeQuiz.question,
      visual: true,
      completeText: true,
    });
  });

  it("bounds a stalled cropped-screenshot operation", async () => {
    const save = vi.fn(() => new Promise<string>(() => undefined));
    const config = { screenshotsDir: "unused" } as never;
    const fullLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await expect(captureQuizScreenshot(page, config, fullLogger, "test-visual", {
      timeoutMs: 10,
      findPanel: async () => undefined,
      save,
      exists: () => true,
      read: () => Buffer.from("unused"),
    })).rejects.toBeInstanceOf(QuizStageTimeoutError);
  });

  it("permanent extraction failure saves diagnostics and pauses safely", async () => {
    const diagnosticSaver = vi.fn(async () => "quiz-extraction-timeout.png");
    const config = { screenshotsDir: "unused" } as never;
    const fullLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    await expect(pauseAfterQuizStageFailure(
      page,
      config,
      fullLogger,
      "QUIZ:q-test",
      "q-test",
      "quiz-extraction",
      new Error("options never stabilized"),
      diagnosticSaver,
    )).rejects.toBeInstanceOf(AutomationPauseError);
    expect(diagnosticSaver).toHaveBeenCalledOnce();
  });
});

describe("actual quiz evidence and answer-option variants", () => {
  const emptyCounts = {
    roleSingle: 0,
    radioInputs: 0,
    checkboxInputs: 0,
    semanticLabels: 0,
    semanticInputs: 0,
    quizOptionContainers: 0,
  };
  const baseEvidence = {
    quizContainer: true,
    submitVisible: true,
    nextQuestionVisible: false,
    quizHeadingVisible: true,
    questionTextVisible: true,
    completeAnswerTexts: true,
  };

  it("recognizes a normal four-choice role=single quiz", () => {
    expect(chooseAnswerOptionStrategy({ ...emptyCounts, roleSingle: 4 })).toEqual({
      strategy: "role-single",
      count: 4,
    });
    expect(classifyQuizEvidence({ ...baseEvidence, answerOptionCount: 4 })).toBe("actual");
  });

  it("accepts a two-choice true/false quiz", () => {
    expect(chooseAnswerOptionStrategy({ ...emptyCounts, roleSingle: 2 })).toEqual({
      strategy: "role-single",
      count: 2,
    });
    expect(classifyQuizEvidence({ ...baseEvidence, answerOptionCount: 2 })).toBe("actual");
  });

  it("supports the Unit 4 quiz-annotation option-container fallback", () => {
    expect(chooseAnswerOptionStrategy({ ...emptyCounts, quizOptionContainers: 4 })).toEqual({
      strategy: "quiz-option-class",
      count: 4,
    });
  });

  it("supports semantic radio or checkbox relationships before class fallbacks", () => {
    expect(chooseAnswerOptionStrategy({
      ...emptyCounts,
      radioInputs: 4,
      semanticLabels: 4,
      quizOptionContainers: 4,
    })).toEqual({ strategy: "semantic-label", count: 4 });
  });

  it("does not classify a generic player annotation as a quiz", () => {
    expect(classifyQuizEvidence({
      ...baseEvidence,
      quizContainer: false,
      submitVisible: false,
      questionTextVisible: false,
      quizHeadingVisible: false,
      answerOptionCount: 0,
    })).toBe("non-quiz");
  });

  it("does not classify a button annotation as a quiz", () => {
    expect(classifyQuizEvidence({
      ...baseEvidence,
      quizContainer: false,
      submitVisible: false,
      answerOptionCount: 0,
    })).toBe("non-quiz");
  });

  it("treats a genuine quiz candidate with zero controls as unsupported while it waits", () => {
    expect(classifyQuizEvidence({ ...baseEvidence, answerOptionCount: 0 })).toBe("unsupported");
  });

  it("rejects partially rendered option text even when clickable targets already exist", () => {
    expect(classifyQuizEvidence({
      ...baseEvidence,
      completeAnswerTexts: false,
      answerOptionCount: 4,
    })).toBe("unsupported");
  });
});

describe("combination/list-statement question extraction", () => {
  const stem = "नेपाल र अङ्ग्रेज बिच के कारणले गर्दा युद्ध सुरु भएको थियो ?";
  const choices = ["I र IV", "I, III र IV", "I, II र III", "I, II, III र IV"];
  const baseSnapshot: QuizDomSnapshot = {
    options: choices,
    preferredTexts: [stem],
    panelText: `Question 10 out of 10\n${stem}\n${choices.join("\n")}`,
    counter: "Question 10 out of 10",
    containerPresent: true,
    meaningfulVisual: false,
    optionTargetCount: 4,
  };

  it("extracts I–IV statements rendered together in a question table", () => {
    const quiz = quizQuestionFromSnapshot({
      ...baseSnapshot,
      statementCandidates: [
        "I) बुटवलको जमिन II) पाल्पा र स्युराजको जमिन III) व्यापार IV) नेपालमा भइरहेको औद्योगिक विकास",
      ],
    });
    expect(quiz.combination).toMatchObject({
      referencedLabels: ["I", "II", "III", "IV"],
      requiresVisual: false,
    });
    expect(quiz.combination?.statements).toEqual([
      { label: "I", text: "बुटवलको जमिन" },
      { label: "II", text: "पाल्पा र स्युराजको जमिन" },
      { label: "III", text: "व्यापार" },
      { label: "IV", text: "नेपालमा भइरहेको औद्योगिक विकास" },
    ]);
    expect(quiz.visual).toBe(false);
  });

  it("extracts labelled statements from separate sibling nodes", () => {
    const combination = detectCombinationQuestion(stem, choices, [
      "I) बुटवलको जमिन",
      "II) पाल्पा र स्युराजको जमिन",
      "III) व्यापार",
      "IV) नेपालमा भइरहेको औद्योगिक विकास",
    ]);
    expect(combination?.requiresVisual).toBe(false);
    expect(formatCombinationStatements(combination!)).toContain("IV. नेपालमा भइरहेको औद्योगिक विकास");
  });

  it("marks a screenshot-only statement table as visual-required", () => {
    const quiz = quizQuestionFromSnapshot(baseSnapshot);
    expect(quiz.combination).toMatchObject({
      referencedLabels: ["I", "II", "III", "IV"],
      statements: [],
      requiresVisual: true,
    });
    expect(quiz.visual).toBe(true);
  });

  it("retries enhanced extraction before accepting a visual statement fallback", async () => {
    const incomplete = quizQuestionFromSnapshot(baseSnapshot);
    const extract = vi.fn(async () => incomplete);
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(extractQuizWithRetry({} as Page, logger, "QUIZ:q-combination", {
      attempts: 3,
      attemptTimeoutMs: 50,
      retryDelayMs: 0,
      minimumOptionCount: 2,
      maximumOptionCount: 6,
    }, {
      extract,
      sleep: async () => undefined,
    })).resolves.toEqual(incomplete);
    expect(extract).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith("QUIZ:q-combination", "Statements missing from DOM; using visual extraction");
  });
});

describe("post-submit state-machine sequences", () => {
  it("four options -> Submit -> zero options -> Continue", async () => {
    const { result, logger } = await observeSequence([
      probeResult(),
      probeResult({ continueVisible: true }),
    ]);
    expect(result).toBe("correct");
    expect(logger.info).toHaveBeenCalledWith("QUIZ", "Previous quiz DOM disappeared");
    expect(logger.info).toHaveBeenCalledWith("QUIZ", "Continue state detected");
  });

  it("four options -> Submit -> zero options -> Retry", async () => {
    const { result } = await observeSequence([
      probeResult(),
      probeResult({ retryVisible: true }),
    ]);
    expect(result).toBe("incorrect");
  });

  it("one temporary option -> complete replacement question", async () => {
    const replacement = fingerprintQuizSnapshot({
      ...oldQuestionSnapshot,
      options: ["W", "X", "Y", "Z"],
      preferredTexts: ["New question?"],
      panelText: "Question 2 out of 10\nNew question?\nW\nX\nY\nZ",
      counter: "Question 2 out of 10",
    })!;
    const { result } = await observeSequence([
      probeResult({ quiz: { optionCount: 1, containerPresent: true } }),
      probeResult({ quiz: { fingerprint: replacement, optionCount: 4, containerPresent: true } }),
    ]);
    expect(result).toBe("advanced");
  });

  it("Next Question replaces the old quiz directly", async () => {
    const replacement = fingerprintQuizSnapshot({
      ...oldQuestionSnapshot,
      preferredTexts: ["Replacement?"],
      panelText: "Question 2 out of 10\nReplacement?\nA\nB\nC\nD",
      counter: "Question 2 out of 10",
    })!;
    const { result, logger } = await observeSequence([
      probeResult({ quiz: { fingerprint: replacement, optionCount: 4, containerPresent: true } }),
    ]);
    expect(result).toBe("advanced");
    expect(logger.info).toHaveBeenCalledWith("QUIZ", "New quiz question detected; previous answer submitted");
  });

  it("final answer -> options disappear -> completion dialog", async () => {
    const { result } = await observeSequence([
      probeResult(),
      probeResult({ completionVisible: true }),
    ]);
    expect(result).toBe("completed");
  });

  it("continues polling through several seconds of slow DOM replacement", async () => {
    const transition = Array.from({ length: 20 }, () => probeResult());
    const { result, probe } = await observeSequence([
      ...transition,
      probeResult({ continueVisible: true }),
    ]);
    expect(result).toBe("correct");
    expect(probe).toHaveBeenCalledTimes(21);
  });

  it("cannot call full extractQuiz from either post-submit observer", () => {
    expect(observePostSubmitState.toString()).not.toContain("extractQuiz");
    expect(observePostSubmitStateWithProbe.toString()).not.toContain("extractQuiz");
    const source = fs.readFileSync(path.join(process.cwd(), "src", "quiz.ts"), "utf8");
    const observerStart = source.indexOf("export async function observePostSubmitStateWithProbe");
    const observerEnd = source.indexOf("async function chooseAnswer", observerStart);
    expect(observerStart).toBeGreaterThan(-1);
    expect(observerEnd).toBeGreaterThan(observerStart);
    expect(source.slice(observerStart, observerEnd)).not.toContain("extractQuiz(");
    expect(source).not.toContain("function waitForResult");
  });
});

describe("quiz question text fallback", () => {
  it("extracts a readable DOM question when narrow question selectors miss it", () => {
    const panelText = [
      "Question 10 out of 10",
      "पाटनका अन्तिम राजा को थिए ?",
      "Choose an answer",
      "पृथ्वीनारायण शाह",
      "जयप्रकाश मल्ल",
      "सिद्दीनरसिंह मल्ल",
      "रणजित मल्ल",
      "Submit",
    ].join("\n");
    expect(selectQuestionText([], panelText, requestOptions)).toBe("पाटनका अन्तिम राजा को थिए ?");
  });
});
