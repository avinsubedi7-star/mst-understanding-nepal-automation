import type { AnswerProvider } from "./answer-provider.js";
import { ManualAnswerProvider } from "./answer-provider.js";
import {
  CodexCliAnswerProvider,
  createCodexRunner,
  parseCodexDecision,
  type CodexAnswerProviderOptions,
} from "./codex-answer-provider.js";
import {
  resolveCodexCli,
  runCodexProcess,
  type CodexCliResolverOptions,
  type CodexProcessRunner,
  type ResolvedCodexCli,
} from "./codex-cli.js";
import type { AppConfig } from "./config.js";
import {
  createGenericCliRunner,
  GenericCliAnswerProvider,
  type GenericCliAnswerProviderOptions,
} from "./generic-cli-answer-provider.js";
import type { Logger } from "./logger.js";

export interface AnswerPreflightDependencies {
  resolveCli: (options: CodexCliResolverOptions) => ResolvedCodexCli;
  processRunner: CodexProcessRunner;
}

const defaultDependencies: AnswerPreflightDependencies = {
  resolveCli: resolveCodexCli,
  processRunner: runCodexProcess,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authenticationError(detail: string): Error {
  return new Error([
    "Codex CLI is installed but is not authenticated with ChatGPT.",
    "Run:",
    "codex login",
    detail ? `Details: ${detail}` : "",
  ].filter(Boolean).join("\n"));
}

function smokeTestPrompt(): string {
  return [
    "Return only the JSON object required by the output schema.",
    "This is a harmless startup readiness check.",
    "Question: What is 1 + 1?",
    "A (0): 1",
    "B (1): 2",
    "Set answerIndex to 1, answerLabel to B, answerText to 2, confidence to 1, source to provider, and give a short reason.",
    "Do not use tools.",
  ].join("\n");
}

function smokeTestRequest() {
  return {
    quiz: {
      question: "What is 1 + 1?",
      options: ["1", "2", "3", "4"],
      visual: false,
      completeText: true,
    },
    attemptedAnswerIndexes: [],
  };
}

function smokeTestError(error: unknown, model: string, reasoning: string): Error {
  const detail = errorText(error);
  const looksLikeModelFailure = /model|unsupported|unavailable|not available|not found|access|404/iu.test(detail);
  if (looksLikeModelFailure) {
    return new Error(`${model} is unavailable in the current Codex subscription/session.\nDetails: ${detail}`);
  }
  return new Error(`Codex provider smoke test failed for ${model}/${reasoning}.\nDetails: ${detail}`);
}

export async function prepareAnswerProvider(
  config: AppConfig,
  logger: Pick<Logger, "info" | "warn">,
  overrides: Partial<AnswerPreflightDependencies> = {},
): Promise<AnswerProvider> {
  if (config.MST_ANSWER_PROVIDER === "manual") {
    logger.info("PRECHECK", "Manual debug answer provider selected; Codex preflight skipped");
    return new ManualAnswerProvider();
  }

  const dependencies = { ...defaultDependencies, ...overrides };
  if (config.MST_ANSWER_PROVIDER === "generic-cli") {
    if (!config.GENERIC_CLI_COMMAND) {
      throw new Error("GENERIC_CLI_COMMAND is required when MST_ANSWER_PROVIDER=generic-cli.");
    }
    const providerOptions: GenericCliAnswerProviderOptions = {
      command: config.GENERIC_CLI_COMMAND,
      args: config.GENERIC_CLI_ARGS_JSON,
      imageArgs: config.GENERIC_CLI_IMAGE_ARGS_JSON,
      supportsVision: config.GENERIC_CLI_SUPPORTS_VISION,
      ...(config.GENERIC_CLI_MODEL ? { model: config.GENERIC_CLI_MODEL } : {}),
      ...(config.GENERIC_CLI_REASONING ? { reasoning: config.GENERIC_CLI_REASONING } : {}),
      timeoutMs: config.GENERIC_CLI_TIMEOUT_MS,
      minimumConfidence: config.MST_MIN_ANSWER_CONFIDENCE,
      workingDirectory: config.root,
    };
    logger.info("PRECHECK", "Checking generic CLI provider...");
    logger.info("PRECHECK", `Executable: ${providerOptions.command}`);
    logger.info("PRECHECK", `Vision: ${providerOptions.supportsVision ? "enabled" : "disabled"}`);
    const provider = new GenericCliAnswerProvider(
      providerOptions,
      logger,
      createGenericCliRunner(dependencies.processRunner),
    );
    logger.info("PRECHECK", "Testing generic CLI structured output...");
    try {
      const decision = await provider.answer(smokeTestRequest());
      if (decision.answerIndex !== 1 || decision.answerLabel !== "B" || decision.answerText !== "2") {
        throw new Error(`Structured output parsed but returned ${decision.answerLabel}/${decision.answerIndex}/${decision.answerText} instead of B/1/2.`);
      }
    } catch (error) {
      throw new Error(`Generic CLI provider smoke test failed. Details: ${errorText(error)}`, { cause: error });
    }
    logger.info("PRECHECK", "Generic CLI smoke test passed");
    logger.info("PRECHECK", "Answer provider ready");
    return provider;
  }

  logger.info("PRECHECK", "Checking Codex CLI...");
  const resolved = dependencies.resolveCli({
    ...(config.CODEX_CLI_PATH ? { overridePath: config.CODEX_CLI_PATH } : {}),
    cwd: config.root,
  });
  logger.info("PRECHECK", `Codex CLI found: ${resolved.executablePath}`);

  logger.info("PRECHECK", "Checking Codex authentication...");
  let authentication;
  try {
    authentication = await dependencies.processRunner(resolved.executablePath, ["login", "status"], {
      cwd: config.root,
      timeoutMs: Math.min(config.MST_CODEX_TIMEOUT_MS, 30_000),
    });
  } catch (error) {
    throw authenticationError(errorText(error));
  }
  const authenticationStatus = `${authentication.stdout}\n${authentication.stderr}`.trim();
  if (!/Logged in using ChatGPT/iu.test(authenticationStatus)) throw authenticationError(authenticationStatus);
  logger.info("PRECHECK", "Authentication: Logged in using ChatGPT");

  const providerOptions: CodexAnswerProviderOptions = {
    executablePath: resolved.executablePath,
    model: config.MST_CODEX_MODEL,
    reasoningEffort: config.MST_CODEX_REASONING,
    timeoutMs: config.MST_CODEX_TIMEOUT_MS,
    minimumConfidence: config.MST_MIN_ANSWER_CONFIDENCE,
    workingDirectory: config.root,
    outputSchemaPath: config.codexAnswerSchemaPath,
  };
  logger.info("PRECHECK", "Testing answer provider...");
  logger.info("PRECHECK", `Model: ${providerOptions.model}`);
  logger.info("PRECHECK", `Reasoning: ${providerOptions.reasoningEffort}`);
  const runner = createCodexRunner(providerOptions, dependencies.processRunner);
  try {
    const decision = parseCodexDecision(await runner({ prompt: smokeTestPrompt() }));
    if (decision.answerIndex !== 1 || decision.answerLabel !== "B" || decision.answerText !== "2") {
      throw new Error(`Structured output parsed but returned ${decision.answerLabel}/${decision.answerIndex}/${decision.answerText} instead of B/1/2.`);
    }
  } catch (error) {
    throw smokeTestError(error, providerOptions.model, providerOptions.reasoningEffort);
  }
  logger.info("PRECHECK", "Codex smoke test passed");
  logger.info("PRECHECK", "Answer provider ready");
  return new CodexCliAnswerProvider(providerOptions, logger, runner);
}
