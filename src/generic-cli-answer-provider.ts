import type { AnswerProvider, AnswerProviderCapabilities, AnswerRequest } from "./answer-provider.js";
import {
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

const IMAGE_PATH_PLACEHOLDER = "{imagePath}";
const MODEL_PLACEHOLDER = "{model}";
const REASONING_PLACEHOLDER = "{reasoning}";

export class UnsupportedProviderCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProviderCapabilityError";
  }
}

export interface GenericCliAnswerProviderOptions {
  command: string;
  args: string[];
  imageArgs: string[];
  supportsVision: boolean;
  model?: string;
  reasoning?: string;
  timeoutMs: number;
  minimumConfidence: number;
  workingDirectory: string;
}

export interface GenericCliRunRequest {
  command: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
  workingDirectory: string;
}

export type GenericCliRunner = (request: GenericCliRunRequest) => Promise<string>;

function renderArgument(template: string, options: GenericCliAnswerProviderOptions, screenshotPath?: string): string {
  if (template === IMAGE_PATH_PLACEHOLDER) {
    if (!screenshotPath) throw new Error("Generic CLI image arguments require a screenshot path.");
    return screenshotPath;
  }
  if (template === MODEL_PLACEHOLDER) {
    if (!options.model) throw new Error("GENERIC_CLI_ARGS_JSON uses {model}, but GENERIC_CLI_MODEL is not configured.");
    return options.model;
  }
  if (template === REASONING_PLACEHOLDER) {
    if (!options.reasoning) throw new Error("GENERIC_CLI_ARGS_JSON uses {reasoning}, but GENERIC_CLI_REASONING is not configured.");
    return options.reasoning;
  }
  return template;
}

export function validateGenericCliOptions(options: GenericCliAnswerProviderOptions): void {
  if (!options.command.trim()) throw new Error("GENERIC_CLI_COMMAND must name an executable.");
  if (options.args.includes(IMAGE_PATH_PLACEHOLDER)) {
    throw new Error("Use GENERIC_CLI_IMAGE_ARGS_JSON, not GENERIC_CLI_ARGS_JSON, for {imagePath}.");
  }
  if (options.imageArgs.length && !options.supportsVision) {
    throw new Error("GENERIC_CLI_IMAGE_ARGS_JSON requires GENERIC_CLI_SUPPORTS_VISION=true.");
  }
  if (options.supportsVision && !options.imageArgs.includes(IMAGE_PATH_PLACEHOLDER)) {
    throw new Error("Vision-enabled generic providers must include {imagePath} in GENERIC_CLI_IMAGE_ARGS_JSON.");
  }
}

export function createGenericCliRunner(
  processRunner: CodexProcessRunner = runCodexProcess,
): GenericCliRunner {
  return async ({ command, args, prompt, timeoutMs, workingDirectory }) => {
    const result = await processRunner(command, args, {
      cwd: workingDirectory,
      timeoutMs,
      input: prompt,
      displayName: "Generic CLI provider",
    });
    return result.stdout;
  };
}

export class GenericCliAnswerProvider implements AnswerProvider {
  readonly id: string;
  readonly capabilities: AnswerProviderCapabilities;
  private readonly runner: GenericCliRunner;

  constructor(
    private readonly options: GenericCliAnswerProviderOptions,
    private readonly logger: Pick<Logger, "info" | "warn">,
    runner?: GenericCliRunner,
  ) {
    validateGenericCliOptions(options);
    this.id = `generic-cli:${options.model ?? "default"}`;
    this.capabilities = {
      text: true,
      vision: options.supportsVision,
      structuredOutput: true,
      nonInteractive: true,
    };
    this.runner = runner ?? createGenericCliRunner();
  }

  async answer(request: AnswerRequest): Promise<AnswerDecision> {
    validateAnswerRequestCompleteness(request);
    if (request.screenshotPath && !this.capabilities.vision) {
      throw new UnsupportedProviderCapabilityError(
        "Current provider does not support visual questions. Configure GENERIC_CLI_SUPPORTS_VISION=true with image arguments, or select a vision-capable provider.",
      );
    }
    const args = [
      ...this.options.args.map((argument) => renderArgument(argument, this.options)),
      ...(request.screenshotPath
        ? this.options.imageArgs.map((argument) => renderArgument(argument, this.options, request.screenshotPath))
        : []),
    ];
    const answerScope = request.processingId ? `ANSWER:${request.processingId}` : "ANSWER";
    this.logger.info(answerScope, `Generic CLI answering${request.screenshotPath ? " with visual input" : ""}`);
    const raw = await this.runner({
      command: this.options.command,
      args,
      prompt: buildAnswerPrompt(request, this.options.minimumConfidence),
      timeoutMs: this.options.timeoutMs,
      workingDirectory: this.options.workingDirectory,
    });
    const decision = validateAnswerDecision(parseAnswerDecision(raw), request);
    if (decision.confidence < this.options.minimumConfidence) {
      throw new AutomationPauseError([
        "Generic CLI confidence is below the configured safety threshold; no answer was clicked.",
        `Question: ${request.quiz.question || "[visual question]"}`,
        `Choices: ${request.quiz.options.map((option, index) => `${answerLabel(index)}=${option}`).join(" | ")}`,
      ].join("\n"));
    }
    return decision;
  }
}
