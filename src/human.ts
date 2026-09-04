import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AnswerDecision, QuizQuestion } from "./types.js";
import { answerLabel } from "./utils.js";

export async function waitForEnter(instruction: string): Promise<void> {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    await terminal.question(`${instruction}\nPress Enter when ready... `);
  } finally {
    terminal.close();
  }
}

export async function askHumanForAnswer(
  quiz: QuizQuestion,
  excluded: Set<number>,
  reason: string,
  screenshotPath?: string,
): Promise<AnswerDecision> {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\nHuman input required: ${reason}`);
    if (screenshotPath) console.log(`Visual question screenshot: ${screenshotPath}`);
    console.log(quiz.question);
    quiz.options.forEach((option, index) => {
      console.log(`${answerLabel(index)}) ${option}${excluded.has(index) ? " [known wrong]" : ""}`);
    });
    while (true) {
      const raw = (await terminal.question("Choose an answer label, or Q to stop: ")).trim().toUpperCase();
      if (raw === "Q") throw new Error("Stopped by user during human review.");
      const index = raw.charCodeAt(0) - 65;
      if (raw.length === 1 && index >= 0 && index < quiz.options.length && !excluded.has(index)) {
        return {
          answerIndex: index,
          answerLabel: answerLabel(index),
          answerText: quiz.options[index] ?? "",
          confidence: 1,
          reason: "Selected by human reviewer",
          source: "human",
        };
      }
      console.log("Enter one available answer label.");
    }
  } finally {
    terminal.close();
  }
}
