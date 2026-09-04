import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerCache } from "../src/cache.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("AnswerCache", () => {
  it("persists and reloads structured answers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mst-cache-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "answers.json");
    const cache = new AnswerCache(file);
    cache.set("question", {
      answerIndex: 3,
      answerLabel: "D",
      answerText: "All of the above",
      confidence: 0.94,
      reason: "All of the above",
      source: "provider",
    });
    expect(new AnswerCache(file).get("question")).toMatchObject({ answerIndex: 3, answerLabel: "D", source: "cache" });
  });
});
