import { describe, expect, it } from "vitest";
import { validateAnswerDecision, type AnswerRequest } from "../src/answer-provider.js";
import type { AnswerDecision } from "../src/types.js";

const request: AnswerRequest = {
  quiz: {
    question: "Question",
    options: ["One", "Two", "Three", "Four"],
    visual: false,
    completeText: true,
  },
  attemptedAnswerIndexes: [0],
};

function decision(overrides: Partial<AnswerDecision> = {}): AnswerDecision {
  return {
    answerIndex: 1,
    answerLabel: "B",
    answerText: "Two",
    confidence: 1,
    reason: "manual selection",
    source: "provider",
    ...overrides,
  };
}

describe("validateAnswerDecision", () => {
  it("accepts a consistent untried answer", () => {
    expect(validateAnswerDecision(decision(), request).answerLabel).toBe("B");
  });

  it("rejects a known-wrong answer", () => {
    expect(() => validateAnswerDecision(decision({ answerIndex: 0, answerLabel: "A" }), request))
      .toThrow(/known-wrong/);
  });

  it("rejects mismatched labels and out-of-range indexes", () => {
    expect(() => validateAnswerDecision(decision({ answerLabel: "C" }), request)).toThrow(/does not match/);
    expect(() => validateAnswerDecision(decision({ answerIndex: 9, answerLabel: "J" }), request)).toThrow(/out-of-range/);
  });

  it("rejects an answer whose text belongs to a different option", () => {
    expect(() => validateAnswerDecision(decision({ answerText: "Four" }), request))
      .toThrow(/does not match option B/);
  });

  it("maps duplicate answer text to the first matching option", () => {
    const duplicateRequest: AnswerRequest = {
      ...request,
      quiz: { ...request.quiz, options: ["I र II", "I, II र III", "I  र   II", "I, II, III र IV"] },
      attemptedAnswerIndexes: [],
    };

    expect(validateAnswerDecision(decision({ answerIndex: 2, answerLabel: "C", answerText: "I र II" }), duplicateRequest))
      .toMatchObject({ answerIndex: 0, answerLabel: "A", answerText: "I र II" });
  });
});
