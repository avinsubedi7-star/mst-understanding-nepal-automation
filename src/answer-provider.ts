import { askHumanForAnswer } from "./human.js";
import { z } from "zod";
import type { AnswerDecision, QuizQuestion } from "./types.js";
import { answerLabel, normalizeText } from "./utils.js";

export class IncompleteCombinationQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteCombinationQuestionError";
  }
}

export class InconsistentAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InconsistentAnswerError";
  }
}

export interface AnswerRequest {
  quiz: QuizQuestion;
  attemptedAnswerIndexes: readonly number[];
  screenshotPath?: string;
  lessonContext?: string;
  processingId?: string;
}

/**
 * Extension point for answering quiz questions.
 *
 * The browser workflow has no knowledge of credentials, models, transports, or
 * billing. Local manual and ChatGPT-authenticated Codex CLI implementations use
 * the same contract.
 */
export interface AnswerProvider {
  readonly id: string;
  readonly capabilities: AnswerProviderCapabilities;
  answer(request: AnswerRequest): Promise<AnswerDecision>;
}

export interface AnswerProviderCapabilities {
  text: true;
  vision: boolean;
  structuredOutput: true;
  nonInteractive: boolean;
}

export const answerDecisionSchema = z.object({
  answerIndex: z.number().int().nonnegative(),
  answerLabel: z.string().regex(/^[A-Z]$/),
  answerText: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  source: z.literal("provider"),
}).strict();

/** Parses only a complete provider-neutral answer object. */
export function parseAnswerDecision(output: string): AnswerDecision {
  const trimmed = output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Answer provider did not return a JSON answer object.");
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  return answerDecisionSchema.parse(parsed);
}

/** Blocks text-only answering when a combination question's labelled evidence is missing. */
export function validateAnswerRequestCompleteness(request: AnswerRequest): void {
  const combination = request.quiz.combination;
  if (combination?.requiresVisual && !request.screenshotPath) {
    throw new IncompleteCombinationQuestionError(
      `Combination question references ${combination.referencedLabels.join(", ")}, but its labelled statements were not extracted from the DOM and no quiz screenshot is available.`,
    );
  }
}

/** Returns every option whose normalized text is equivalent to the supplied answer text. */
export function matchingAnswerOptionIndexes(options: readonly string[], answerText: string): number[] {
  const normalizedAnswer = normalizeText(answerText).replace(/\s*([,;:])\s*/gu, "$1 ").trim();
  return options.flatMap((option, index) => {
    const normalizedOption = normalizeText(option).replace(/\s*([,;:])\s*/gu, "$1 ").trim();
    return normalizedOption === normalizedAnswer ? [index] : [];
  });
}

export function validateAnswerDecision(
  decision: AnswerDecision,
  request: AnswerRequest,
): AnswerDecision {
  const { options } = request.quiz;
  if (!Number.isInteger(decision.answerIndex) || decision.answerIndex < 0 || decision.answerIndex >= options.length) {
    throw new Error(`Answer provider returned out-of-range index ${decision.answerIndex}.`);
  }
  const textMatches = matchingAnswerOptionIndexes(options, decision.answerText);
  const selectedIndex = textMatches.length > 1
    ? textMatches.find((index) => !request.attemptedAnswerIndexes.includes(index)) ?? decision.answerIndex
    : decision.answerIndex;
  if (request.attemptedAnswerIndexes.includes(selectedIndex)) {
    throw new Error(`Answer provider repeated known-wrong option ${answerLabel(selectedIndex)}.`);
  }
  const expected = answerLabel(selectedIndex);
  const selectedOption = options[selectedIndex] ?? "";
  if (textMatches.length <= 1 && decision.answerLabel.toUpperCase() !== expected) {
    throw new InconsistentAnswerError(`Answer label ${decision.answerLabel} does not match index ${selectedIndex}.`);
  }
  if (textMatches.length <= 1 && textMatches[0] !== selectedIndex) {
    throw new InconsistentAnswerError(
      `Answer text ${JSON.stringify(decision.answerText)} does not match option ${expected}: ${JSON.stringify(selectedOption)}.`,
    );
  }
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) {
    throw new Error("Answer provider confidence must be between 0 and 1.");
  }
  return { ...decision, answerIndex: selectedIndex, answerLabel: expected, answerText: selectedOption };
}

export class ManualAnswerProvider implements AnswerProvider {
  readonly id = "manual-terminal";
  readonly capabilities: AnswerProviderCapabilities = {
    text: true,
    vision: true,
    structuredOutput: true,
    nonInteractive: false,
  };

  async answer(request: AnswerRequest): Promise<AnswerDecision> {
    validateAnswerRequestCompleteness(request);
    return askHumanForAnswer(
      request.quiz,
      new Set(request.attemptedAnswerIndexes),
      "Manual debug mode is enabled.",
      request.screenshotPath,
    );
  }
}
