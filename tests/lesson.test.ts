import { describe, expect, it } from "vitest";
import { choosePlayStartTarget, extractEndQuizScore, playbackStarted } from "../src/lesson.js";

describe("normal video playback startup", () => {
  it("prioritizes the thumbnail play overlay over the intercepted video surface", () => {
    expect(choosePlayStartTarget({
      thumbnailOverlayVisible: true,
      overlayVisible: true,
      accessiblePlayVisible: true,
      videoVisible: true,
    })).toBe("initial-overlay");
  });

  it("requires the overlay click to cause playback, not merely hide the overlay", () => {
    expect(playbackStarted(0, { currentTime: 0, paused: false })).toBe(true);
    expect(playbackStarted(0, { currentTime: 0.2, paused: true })).toBe(true);
    expect(playbackStarted(0, { currentTime: 0, paused: true })).toBe(false);
  });

  it("uses the normal Play control for a resumed lesson without an initial overlay", () => {
    expect(choosePlayStartTarget({
      thumbnailOverlayVisible: false,
      overlayVisible: false,
      accessiblePlayVisible: true,
      videoVisible: true,
    })).toBe("player-control");
  });
});

describe("end-of-lesson result reporting", () => {
  it("extracts an explicitly labelled final score", () => {
    expect(extractEndQuizScore("Quiz completed. Your score: 10 / 10")).toBe("10/10");
    expect(extractEndQuizScore("Answered 10 / 10")).toBeUndefined();
  });

  it("checks the completion report before stale final-question DOM can be processed again", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("src/lesson.ts", "utf8"));
    const completionCheck = source.indexOf("if (endQuizMode && await endQuizFinished(page))");
    const quizCheck = source.indexOf("if (await waitForQuiz(page, 500, logger))");
    expect(completionCheck).toBeGreaterThan(-1);
    expect(quizCheck).toBeGreaterThan(completionCheck);
  });
});
