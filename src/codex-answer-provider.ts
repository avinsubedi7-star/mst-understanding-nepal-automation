import type { AnswerProvider, AnswerProviderCapabilities, AnswerRequest } from "./answer-provider.js";
import {
  InconsistentAnswerError,
  matchingAnswerOptionIndexes,
  parseAnswerDecision,
  validateAnswerDecision,
  validateAnswerRequestCompleteness,
} from "./answer-provider.js";
import { AutomationPauseError } from "./automation-errors.js";
import { buildAnswerPrompt } from "./answer-prompt.js";
import { runCodexProcess, type CodexProcessRunner } from "./codex-cli.js";
import type { Logger } from "./logger.js";
import type { AnswerDecision } from "./types.js";
import { answerLabel } from "./utils.js";

export interface CodexAnswerProviderOptions {
  executablePath: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  minimumConfidence: number;
  workingDirectory: string;
  outputSchemaPath: string;
}

export interface CodexRunRequest {
  prompt: string;
  screenshotPath?: string;
  reasoningEffort?: CodexAnswerProviderOptions["reasoningEffort"];
}

export type CodexRunner = (request: CodexRunRequest) => Promise<string>;

/** Backward-compatible Codex export; the prompt is provider-neutral. */
export const buildCodexQuizPrompt = buildAnswerPrompt;

/** Backward-compatible Codex export; the schema is provider-neutral. */
export function parseCodexDecision(output: string): AnswerDecision {
  try {
    return parseAnswerDecision(output);
  } catch (error) {
    if (error instanceof Error && error.message === "Answer provider did not return a JSON answer object.") {
      throw new Error("Codex did not return a JSON answer object.", { cause: error });
    }
    throw error;
  }
}

export function createCodexRunner(
  options: CodexAnswerProviderOptions,
  processRunner: CodexProcessRunner = runCodexProcess,
): CodexRunner {
  return async ({ prompt, screenshotPath, reasoningEffort }) => {
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "--model", options.model,
      "-c", `model_reasoning_effort="${reasoningEffort ?? options.reasoningEffort}"`,
      "--output-schema", options.outputSchemaPath,
    ];
    if (screenshotPath) args.push("--image", screenshotPath);
    args.push("-");

    const result = await processRunner(options.executablePath, args, {
      cwd: options.workingDirectory,
      timeoutMs: options.timeoutMs,
      input: prompt,
    });
    return result.stdout;
  };
}

export class CodexCliAnswerProvider implements AnswerProvider {
  readonly id: string;
  readonly capabilities: AnswerProviderCapabilities = {
    text: true,
    vision: true,
    structuredOutput: true,
    nonInteractive: true,
  };
  private readonly runner: CodexRunner;

  constructor(
    private readonly options: CodexAnswerProviderOptions,
    private readonly logger: Pick<Logger, "info" | "warn">,
    runner?: CodexRunner,
  ) {
    this.id = `codex-cli:${options.model}/${options.reasoningEffort}`;
    this.runner = runner ?? createCodexRunner(options);
  }

  async answer(request: AnswerRequest): Promise<AnswerDecision> {
    validateAnswerRequestCompleteness(request);
    let previousAttempt: string | undefined;
    let lastProblem: string;
    const answerScope = request.processingId ? `ANSWER:${request.processingId}` : "ANSWER";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      this.logger.info(answerScope, `Sol/medium attempt ${attempt}/2${request.screenshotPath ? " with visual input" : ""}`);
      try {
        const raw = await this.runner({
          prompt: buildCodexQuizPrompt(request, this.options.minimumConfidence, previousAttempt),
          ...(request.screenshotPath ? { screenshotPath: request.screenshotPath } : {}),
          reasoningEffort: this.options.reasoningEffort,
        });
        let decision: AnswerDecision;
        try {
          decision = this.validateDecision(parseCodexDecision(raw), request, answerScope);
        } catch (error) {
          if (error instanceof InconsistentAnswerError) {
            this.logger.warn(answerScope, attempt === 1
              ? "Inconsistent Codex answer detected; retrying"
              : "Inconsistent Codex answer detected on final medium attempt");
            previousAttempt = `The previous JSON had an answer index/label/text mismatch and was rejected. Previous JSON: ${raw}`;
          }
          throw error;
        }
        previousAttempt = JSON.stringify(decision);
        if (decision.confidence >= this.options.minimumConfidence) return decision;
        this.logger.warn(answerScope, `Low confidence: ${decision.confidence.toFixed(2)}`);
      } catch (error) {
        const problem = error instanceof Error ? error.message : String(error);
        previousAttempt ??= problem;
        if (attempt === 1 && !(error instanceof InconsistentAnswerError)) {
          this.logger.warn(answerScope, `First Codex answer was invalid; retrying once: ${problem}`);
        }
      }
    }

    this.logger.info(answerScope, "Escalating difficult question to Sol/high");
    try {
      const raw = await this.runner({
        prompt: buildCodexQuizPrompt(request, this.options.minimumConfidence, undefined, true),
        ...(request.screenshotPath ? { screenshotPath: request.screenshotPath } : {}),
        reasoningEffort: "high",
      });
      const decision = this.validateDecision(parseCodexDecision(raw), request, answerScope);
      if (decision.confidence >= this.options.minimumConfidence) {
        this.logger.info(
          answerScope,
          `Sol/high selected ${decision.answerLabel} (confidence ${decision.confidence.toFixed(2)})`,
        );
        return decision;
      }
      lastProblem = `confidence ${decision.confidence.toFixed(2)} is below ${this.options.minimumConfidence.toFixed(2)}`;
      this.logger.warn(
        answerScope,
        `Sol/high confidence ${decision.confidence.toFixed(2)} remains below ${this.options.minimumConfidence.toFixed(2)}`,
      );
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
      if (error instanceof InconsistentAnswerError) {
        this.logger.warn(answerScope, "Inconsistent Sol/high answer detected; pausing without clicking");
      } else {
        this.logger.warn(answerScope, `Sol/high answer was invalid: ${lastProblem}`);
      }
    }

    this.logger.warn(request.processingId ? `PAUSE:${request.processingId}` : "PAUSE", "Unable to answer safely after adaptive reasoning escalation");
    throw new AutomationPauseError([
      "Unable to answer safely after adaptive reasoning escalation.",
      `Question: ${request.quiz.question || "[visual question]"}`,
      `Choices: ${request.quiz.options.map((option, index) => `${answerLabel(index)}=${option}`).join(" | ")}`,
      `Known wrong: ${request.attemptedAnswerIndexes.map(answerLabel).join(", ") || "none"}`,
      `Last issue: ${lastProblem}`,
      request.screenshotPath ? `Screenshot: ${request.screenshotPath}` : "",
    ].filter(Boolean).join("\n"));
  }

  private validateDecision(decision: AnswerDecision, request: AnswerRequest, answerScope: string): AnswerDecision {
    const matches = matchingAnswerOptionIndexes(request.quiz.options, decision.answerText);
    const validated = validateAnswerDecision(decision, request);
    if (matches.length > 1) {
      this.logger.info(answerScope, `Duplicate equivalent choices detected: ${matches.map(answerLabel).join(", ")}`);
      this.logger.info(answerScope, `Choosing ${validated.answerLabel} as deterministic duplicate match`);
    }
    return validated;
  }
}
