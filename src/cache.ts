import fs from "node:fs";
import path from "node:path";
import type { AnswerDecision } from "./types.js";

interface CacheFile {
  version: 1;
  answers: Record<string, Omit<AnswerDecision, "source"> & { updatedAt: string }>;
}

export class AnswerCache {
  private data: CacheFile = { version: 1, answers: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  get(key: string): AnswerDecision | undefined {
    const found = this.data.answers[key];
    return found ? { ...found, source: "cache" } : undefined;
  }

  set(key: string, answer: AnswerDecision): void {
    this.data.answers[key] = {
      answerIndex: answer.answerIndex,
      answerLabel: answer.answerLabel,
      answerText: answer.answerText,
      confidence: answer.confidence,
      reason: answer.reason,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  delete(key: string): void {
    if (this.data.answers[key]) {
      delete this.data.answers[key];
      this.save();
    }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as CacheFile;
      if (parsed.version === 1 && parsed.answers) this.data = parsed;
    } catch {
      const backup = `${this.filePath}.invalid-${Date.now()}`;
      fs.renameSync(this.filePath, backup);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, this.filePath);
  }
}
