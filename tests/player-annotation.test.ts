import { describe, expect, it } from "vitest";
import { annotationActionSucceeded } from "../src/player-annotation.js";

describe("annotationActionSucceeded", () => {
  it("requires the Continue annotation to disappear and playback to resume", () => {
    expect(annotationActionSucceeded("continue", {
      annotationVisible: false,
      quizVisible: false,
      beforeTime: 10,
      currentTime: 10.5,
      paused: true,
    })).toBe(true);
    expect(annotationActionSucceeded("continue", {
      annotationVisible: false,
      quizVisible: false,
      beforeTime: 10,
      currentTime: 10,
      paused: false,
    })).toBe(true);
    expect(annotationActionSucceeded("continue", {
      annotationVisible: true,
      quizVisible: false,
      beforeTime: 10,
      currentTime: 11,
      paused: false,
    })).toBe(false);
    expect(annotationActionSucceeded("continue", {
      annotationVisible: false,
      quizVisible: false,
      beforeTime: 10,
      currentTime: 10,
      paused: true,
    })).toBe(false);
  });

  it("requires the quiz options to reappear after Retry", () => {
    expect(annotationActionSucceeded("retry", {
      annotationVisible: false,
      quizVisible: true,
      beforeTime: undefined,
      currentTime: undefined,
      paused: undefined,
    })).toBe(true);
    expect(annotationActionSucceeded("retry", {
      annotationVisible: false,
      quizVisible: false,
      beforeTime: undefined,
      currentTime: undefined,
      paused: undefined,
    })).toBe(false);
  });
});
