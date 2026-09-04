import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSpawnInvocation,
  CodexCliNotFoundError,
  resolveCodexCli,
  spawnErrorFor,
} from "../src/codex-cli.js";

describe("resolveCodexCli", () => {
  it("resolves a Codex executable present on PATH through where.exe", () => {
    const executable = path.resolve("C:\\Tools\\Codex\\codex.exe");
    expect(resolveCodexCli({
      platform: "win32",
      environment: { PATH: "C:\\Tools\\Codex" },
      whereLookup: () => [executable],
      knownLocations: [],
      fileExists: (candidate) => candidate === executable,
      realpath: (candidate) => candidate,
    })).toEqual({ executablePath: executable, source: "where" });
  });

  it("uses CODEX_CLI_PATH before all automatic lookup methods", () => {
    const executable = path.resolve("C:\\Custom Codex\\codex.exe");
    expect(resolveCodexCli({
      overridePath: executable,
      platform: "win32",
      whereLookup: () => [path.resolve("C:\\Elsewhere\\codex.exe")],
      fileExists: (candidate) => candidate === executable,
      realpath: (candidate) => candidate,
    })).toEqual({ executablePath: executable, source: "override" });
  });

  it("fails clearly when no standalone executable exists", () => {
    expect(() => resolveCodexCli({
      platform: "win32",
      environment: { PATH: "" },
      whereLookup: () => [],
      knownLocations: [],
      fileExists: () => false,
    })).toThrow(CodexCliNotFoundError);
  });

  it("ignores an automatically discovered VS Code extension executable", () => {
    const bundled = path.resolve("C:\\Users\\Test\\.vscode\\extensions\\openai.chatgpt-1\\bin\\codex.exe");
    const standalone = path.resolve("C:\\Users\\Test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe");
    expect(resolveCodexCli({
      platform: "win32",
      environment: { PATH: "" },
      whereLookup: () => [bundled],
      knownLocations: [standalone],
      fileExists: () => true,
      realpath: (candidate) => candidate,
    })).toEqual({ executablePath: standalone, source: "known-location" });
  });
});

describe("Windows Codex process invocation", () => {
  it("spawns an exe directly using its absolute path", () => {
    const executable = "C:\\Program Files\\OpenAI\\Codex\\codex.exe";
    const invocation = buildSpawnInvocation(executable, ["--version"], "win32", { SystemRoot: "C:\\Windows" });
    expect(invocation.command).toBe(executable);
    expect(invocation.args).toEqual(["--version"]);
  });

  it("invokes a cmd wrapper through PowerShell without a concatenated shell command", () => {
    const executable = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd";
    const invocation = buildSpawnInvocation(executable, ["exec", "--model", "gpt-5.6-sol"], "win32", {
      SystemRoot: "C:\\Windows",
    });
    expect(invocation.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const payload = JSON.parse(Buffer.from(invocation.environment.MST_CODEX_INVOCATION!, "base64").toString("utf8")) as {
      executable: string;
      arguments: string[];
    };
    expect(payload).toEqual({ executable, arguments: ["exec", "--model", "gpt-5.6-sol"] });
  });

  it("turns ENOENT into an actionable resolved-path error", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(spawnErrorFor("C:\\missing\\codex.exe", error)).toMatchObject({ kind: "not-found" });
    expect(spawnErrorFor("C:\\missing\\codex.exe", error).message).toContain("resolved executable");
  });
});
