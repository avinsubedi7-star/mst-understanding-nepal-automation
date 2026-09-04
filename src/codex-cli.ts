import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type CodexCliSource = "override" | "where" | "path" | "known-location";

export interface ResolvedCodexCli {
  executablePath: string;
  source: CodexCliSource;
}

export interface CodexCliResolverOptions {
  overridePath?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  fileExists?: (candidate: string) => boolean;
  realpath?: (candidate: string) => string;
  whereLookup?: () => string[];
  knownLocations?: string[];
}

export interface CodexProcessResult {
  stdout: string;
  stderr: string;
}

export interface CodexProcessOptions {
  cwd: string;
  timeoutMs: number;
  input?: string;
  displayName?: string;
}

export interface SpawnInvocation {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export type CodexProcessRunner = (
  executablePath: string,
  args: string[],
  options: CodexProcessOptions,
) => Promise<CodexProcessResult>;

const NOT_FOUND_MESSAGE = [
  "Codex CLI was not found.",
  "",
  "Install/configure the standalone Codex CLI, or set:",
  "CODEX_CLI_PATH=<absolute path>",
  "",
  "The VS Code Codex extension alone is not sufficient for this Node child-process integration.",
].join("\n");

export class CodexCliNotFoundError extends Error {
  constructor(detail?: string) {
    super(detail ? `${NOT_FOUND_MESSAGE}\n\n${detail}` : NOT_FOUND_MESSAGE);
    this.name = "CodexCliNotFoundError";
  }
}

export class CodexProcessError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "timeout" | "non-zero" | "spawn",
  ) {
    super(message);
    this.name = "CodexProcessError";
  }
}

function splitPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return (environment.PATH ?? environment.Path ?? environment.path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function pathCandidates(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const names = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => `codex${extension.toLowerCase()}`)
    : ["codex"];
  return splitPath(environment, platform).flatMap((directory) => names.map((name) => path.join(directory, name)));
}

function defaultKnownLocations(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [
      environment.LOCALAPPDATA
        ? path.join(environment.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe")
        : "",
      environment.APPDATA ? path.join(environment.APPDATA, "npm", "codex.cmd") : "",
    ].filter(Boolean);
  }
  return [
    environment.HOME ? path.join(environment.HOME, ".local", "bin", "codex") : "",
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ].filter(Boolean);
}

function defaultWhereLookup(): string[] {
  const result = spawnSync("where.exe", ["codex"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function isBundledIdeExecutable(candidate: string): boolean {
  const normalized = candidate.replaceAll("/", "\\").toLowerCase();
  return normalized.includes("\\.vscode\\extensions\\openai.chatgpt-")
    || normalized.includes("\\.vscode-insiders\\extensions\\openai.chatgpt-");
}

export function resolveCodexCli(options: CodexCliResolverOptions = {}): ResolvedCodexCli {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.fileExists ?? fs.existsSync;
  const canonicalize = options.realpath ?? ((candidate: string) => fs.realpathSync.native(candidate));

  if (options.overridePath) {
    const override = path.resolve(cwd, options.overridePath);
    if (!exists(override)) {
      throw new CodexCliNotFoundError(`CODEX_CLI_PATH does not point to an existing file: ${override}`);
    }
    return { executablePath: canonicalize(override), source: "override" };
  }

  const groups: Array<{ source: CodexCliSource; candidates: string[] }> = [
    {
      source: "where",
      candidates: platform === "win32" ? (options.whereLookup ?? defaultWhereLookup)() : [],
    },
    { source: "path", candidates: pathCandidates(environment, platform) },
    {
      source: "known-location",
      candidates: options.knownLocations ?? defaultKnownLocations(environment, platform),
    },
  ];

  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group.candidates) {
      const candidate = path.resolve(value);
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || isBundledIdeExecutable(candidate)) continue;
      seen.add(key);
      if (exists(candidate)) return { executablePath: canonicalize(candidate), source: group.source };
    }
  }

  throw new CodexCliNotFoundError();
}

const POWERSHELL_WRAPPER_SCRIPT = [
  "$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MST_CODEX_INVOCATION));",
  "$spec=$json | ConvertFrom-Json;",
  "& $spec.executable @($spec.arguments);",
  "exit $LASTEXITCODE",
].join(" ");

export function buildSpawnInvocation(
  executablePath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): SpawnInvocation {
  const extension = path.extname(executablePath).toLowerCase();
  if (platform !== "win32" || ![".cmd", ".bat", ".ps1"].includes(extension)) {
    return { command: executablePath, args, environment };
  }

  const powershell = environment.SystemRoot
    ? path.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const encodedScript = Buffer.from(POWERSHELL_WRAPPER_SCRIPT, "utf16le").toString("base64");
  const payload = Buffer.from(JSON.stringify({ executable: executablePath, arguments: args }), "utf8").toString("base64");
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
    environment: { ...environment, MST_CODEX_INVOCATION: payload },
  };
}

export function spawnErrorFor(executablePath: string, error: Error, displayName = "Codex CLI"): CodexProcessError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new CodexProcessError(
      `${displayName} could not be launched because the resolved executable no longer exists or is inaccessible: ${executablePath}`,
      "not-found",
    );
  }
  return new CodexProcessError(`Failed to launch ${displayName} at ${executablePath}: ${error.message}`, "spawn");
}

export function runCodexProcess(
  executablePath: string,
  args: string[],
  options: CodexProcessOptions,
): Promise<CodexProcessResult> {
  return new Promise((resolve, reject) => {
    const invocation = buildSpawnInvocation(executablePath, args);
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: invocation.environment,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = spawn(invocation.command, invocation.args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new CodexProcessError(
        options.displayName
          ? `${options.displayName} process timed out after ${options.timeoutMs} ms.`
          : `Codex process timed out after ${options.timeoutMs} ms.`,
        "timeout",
      ));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => finish(spawnErrorFor(executablePath, error, options.displayName)));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new CodexProcessError(
        options.displayName
          ? `${options.displayName} exited with code ${code ?? "unknown"}: ${(stderr || stdout).trim().slice(-2_000)}`
          : `Codex exited with code ${code ?? "unknown"}: ${(stderr || stdout).trim().slice(-2_000)}`,
        "non-zero",
      ));
    });
    child.stdin.end(options.input ?? "", "utf8");
  });
}
