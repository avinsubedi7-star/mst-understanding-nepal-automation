import type { AnswerRequest } from "./answer-provider.js";
import { answerLabel } from "./utils.js";

/** Builds the provider-neutral quiz prompt used by local CLI answer providers. */
export function buildAnswerPrompt(
  request: AnswerRequest,
  minimumConfidence: number,
  previousAttempt?: string,
  escalation = false,
): string {
  const options = request.quiz.options
    .map((option, index) => `${answerLabel(index)} (${index}): ${option}`)
    .join("\n");
  const excluded = request.attemptedAnswerIndexes.length
    ? request.attemptedAnswerIndexes.map((index) => `${answerLabel(index)} (${index})`).join(", ")
    : "none";
  const visualInstruction = request.screenshotPath
    ? "A screenshot of the actual visible quiz is attached. Inspect its image, diagram, map, chart, symbols, question, and choices together."
    : "No screenshot is attached because the question was fully readable from the DOM.";
  const combination = request.quiz.combination;
  const combinationInstruction = combination
    ? combination.requiresVisual
      ? [
          `This is a combination/list-statement question. The choices refer to these statement labels: ${combination.referencedLabels.join(", ")}.`,
          "The labelled statements were not reliably extractable from the DOM. Read every labelled statement from the attached quiz screenshot before choosing; do not answer from the combinations alone.",
        ]
      : [
          `This is a combination/list-statement question. Evaluate every labelled statement: ${combination.referencedLabels.join(", ")}.`,
          "Use the structured Statements section below before mapping the correct combination to a choice.",
        ]
    : [];
  const structuredQuestion = combination
    ? [
        "Question:",
        request.quiz.question,
        "",
        "Statements:",
        combination.statements.length
          ? combination.statements.map((statement) => `${statement.label}. ${statement.text}`).join("\n")
          : "[Read the labelled statements from the attached screenshot.]",
      ].join("\n")
    : `Question: ${request.quiz.question || "[The question is primarily visual; read it from the attached screenshot.]"}`;
  const escalationInstructions = escalation
    ? [
        "This is the single high-reasoning escalation because two medium-reasoning attempts remained uncertain or unusable.",
        "Solve independently; do not anchor on or merely raise the confidence of earlier guesses.",
        "Carefully inspect the entire cropped quiz screenshot and read the complete question stem.",
        "Account for every relevant image, diagram, historical figure, quotation, map, and other visual clue.",
      ]
    : [];

  return [
    "Answer this Nepali Social Studies multiple-choice question.",
    "Solve the question carefully using the question, all choices, and any attached image.",
    ...escalationInstructions,
    visualInstruction,
    ...combinationInstruction,
    "Do not use shell, browser, web, or file tools. Everything needed is in this prompt and the attached image.",
    "First identify the exact answer text. Then map that exact text to the listed A/B/C/D option and zero-based index.",
    "Before responding, verify that answerIndex, answerLabel, and answerText all identify the same listed option.",
    "Return only the terse JSON object required by the output schema; keep reason to one short sentence.",
    `Calibrate confidence from 0 to 1. Use less than ${minimumConfidence} when genuinely uncertain.`,
    `Never select a known-wrong choice: ${excluded}.`,
    escalation
      ? "Earlier medium attempts were uncertain or unusable; do not reuse their guesses."
      : previousAttempt
        ? `A previous reasoning attempt was unusable or low-confidence. Reconsider independently and correct it. Previous result: ${previousAttempt}`
        : "This is the first reasoning attempt.",
    "",
    request.lessonContext ? `Lesson context: ${request.lessonContext}` : "",
    structuredQuestion,
    "Choices:",
    options,
  ].join("\n");
}
