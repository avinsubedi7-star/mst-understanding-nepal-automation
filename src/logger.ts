import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly logFile: string;

  constructor(
    logsDir: string,
    private readonly minimum: Level = "info",
  ) {
    fs.mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    this.logFile = path.join(logsDir, `mst-${stamp}.log`);
  }

  debug(scope: string, message: string): void { this.write("debug", scope, message); }
  info(scope: string, message: string): void { this.write("info", scope, message); }
  warn(scope: string, message: string): void { this.write("warn", scope, message); }
  error(scope: string, message: string): void { this.write("error", scope, message); }

  private write(level: Level, scope: string, message: string): void {
    if (order[level] < order[this.minimum]) return;
    const safe = message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]");
    const consoleLine = `[${scope}] ${safe}`;
    const fileLine = `${new Date().toISOString()} ${level.toUpperCase()} ${consoleLine}\n`;
    if (level === "error") console.error(consoleLine);
    else if (level === "warn") console.warn(consoleLine);
    else console.log(consoleLine);
    fs.appendFileSync(this.logFile, fileLine, "utf8");
  }
}
