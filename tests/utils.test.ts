import { describe, expect, it } from "vitest";
import { answerLabel, formatTime, normalizeText, stableQuestionHash } from "../src/utils.js";

describe("utility helpers", () => {
  it("normalizes Unicode whitespace without damaging Nepali text", () => {
    expect(normalizeText("  नेपालको\n  संविधान  ")).toBe("नेपालको संविधान");
  });

  it("creates deterministic question hashes", () => {
    expect(stableQuestionHash(" Q ", ["A", "B"]))
      .toBe(stableQuestionHash("Q", [" A ", "B"]));
    expect(stableQuestionHash("Q", ["A", "B"], "image-1"))
      .not.toBe(stableQuestionHash("Q", ["A", "B"], "image-2"));
  });

  it("formats labels and video time", () => {
    expect(answerLabel(3)).toBe("D");
    expect(formatTime(428)).toBe("07:08");
    expect(formatTime(3661)).toBe("1:01:01");
  });
});
