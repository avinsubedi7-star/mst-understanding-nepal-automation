import path from "node:path";
import { z } from "zod";

const jsonStringArray = (name: string) => z.string().default("[]").transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return parsed;
  } catch {
    context.addIssue({ code: "custom", message: `${name} must be a JSON array of strings.` });
    return z.NEVER;
  }
});

const envSchema = z.object({
  MST_START_URL: z.string().url().default(
    "https://app.mysecondteacher.com.np/",
  ),
  MST_SUBJECT_NAME: z.string().default("Understanding Nepal: Society, History, and Governance"),
  MST_DISCOVER_FROM_CATALOGUE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MST_BROWSER_CHANNEL: z.string().default("chrome"),
  MST_ANSWER_PROVIDER: z.enum(["codex", "generic-cli", "manual"]).default("codex"),
  CODEX_CLI_PATH: z.string().trim().min(1).optional(),
  MST_CODEX_MODEL: z.string().default("gpt-5.6-sol"),
  MST_CODEX_REASONING: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  MST_CODEX_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(180_000),
  GENERIC_CLI_COMMAND: z.string().trim().min(1).optional(),
  GENERIC_CLI_ARGS_JSON: jsonStringArray("GENERIC_CLI_ARGS_JSON"),
  GENERIC_CLI_IMAGE_ARGS_JSON: jsonStringArray("GENERIC_CLI_IMAGE_ARGS_JSON"),
  GENERIC_CLI_SUPPORTS_VISION: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  GENERIC_CLI_MODEL: z.string().trim().min(1).optional(),
  GENERIC_CLI_REASONING: z.string().trim().min(1).optional(),
  GENERIC_CLI_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(180_000),
  MST_MIN_ANSWER_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.65),
  MST_AUTH_TIMEOUT_MINUTES: z.coerce.number().int().min(0).default(0),
  MST_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(1000),
  MST_RESULT_TIMEOUT_MS: z.coerce.number().int().min(3000).default(45_000),
  MST_SESSION_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(720),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const env = envSchema.parse(process.env);
const root = process.cwd();

export const config = {
  ...env,
  root,
  profileDir: path.join(root, "mst-profile"),
  logsDir: path.join(root, "logs"),
  screenshotsDir: path.join(root, "screenshots"),
  dataDir: path.join(root, "data"),
  cachePath: path.join(root, "data", "answers.json"),
  codexAnswerSchemaPath: path.join(root, "src", "codex-answer-schema.json"),
};

export type AppConfig = typeof config;
