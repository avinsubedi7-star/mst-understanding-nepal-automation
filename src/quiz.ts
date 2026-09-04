import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { AnswerProvider, AnswerRequest } from "./answer-provider.js";
import { validateAnswerDecision, validateAnswerRequestCompleteness } from "./answer-provider.js";
import type { AppConfig } from "./config.js";
import { AnswerCache } from "./cache.js";
import { AutomationPauseError } from "./automation-errors.js";
import { saveDiagnostic } from "./diagnostics.js";
import type { Logger } from "./logger.js";
import { clickPlayerAnnotation, playerAnnotationLocator } from "./player-annotation.js";
import type { AnswerDecision, CombinationQuestionContext, CombinationStatement, QuizOutcome, QuizQuestion } from "./types.js";
import { answerLabel, bufferHash, normalizeText, sleep, stableQuestionHash } from "./utils.js";

export const POST_SUBMIT_CANDIDATE_STATES = [
  "continue annotation",
  "retry annotation",
  "known correct/incorrect result marker",
  "next question with a different signature",
  "end-of-lesson completion/result",
  "quiz DOM disappearing or being replaced",
  "visible next/finish/done/complete control",
  "quiz dismissed with video playback resumed",
] as const;

export const QUIZ_STAGE_TIMEOUTS = {
  lessonContext: 5_000,
  domSnapshot: 4_000,
  screenshot: 10_000,
  diagnostics: 10_000,
  interaction: 10_000,
  postSubmitProbe: 2_000,
} as const;

export const QUIZ_EXTRACTION_ATTEMPTS = 3;
export const QUIZ_MIN_OPTION_COUNT = 2;
export const QUIZ_MAX_OPTION_COUNT = 6;
const QUIZ_EXTRACTION_RETRY_MS = 2_000;
const QUIZ_HEARTBEAT_MS = 5_000;
let quizProcessingSequence = 0;

function nextQuizProcessingId(): string {
  quizProcessingSequence += 1;
  return `q-${Date.now().toString(36)}-${quizProcessingSequence.toString(36)}`;
}

export class QuizStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
  ) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = "QuizStageTimeoutError";
  }
}

export async function withStageTimeout<T>(
  stage: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  onHeartbeat?: (elapsedMs: number) => void,
  heartbeatMs = QUIZ_HEARTBEAT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new QuizStageTimeoutError(stage, timeoutMs)), timeoutMs);
  });
  if (onHeartbeat && heartbeatMs > 0 && heartbeatMs < timeoutMs) {
    heartbeatHandle = setInterval(() => onHeartbeat(Date.now() - startedAt), heartbeatMs);
  }
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (heartbeatHandle) clearInterval(heartbeatHandle);
  }
}

export interface QuizDomSnapshot {
  options: string[];
  preferredTexts: string[];
  panelText: string;
  counter?: string;
  containerPresent: boolean;
  meaningfulVisual: boolean;
  optionTargetCount?: number;
  answerCandidates?: AnswerOptionCandidateCounts;
  statementCandidates?: string[];
}

export type AnswerOptionStrategy = "role-single" | "semantic-label" | "semantic-input" | "quiz-option-class" | "none";

export interface AnswerOptionCandidateCounts {
  roleSingle: number;
  radioInputs: number;
  checkboxInputs: number;
  semanticLabels: number;
  semanticInputs: number;
  quizOptionContainers: number;
}

export interface VisibleAnswerOptions {
  locator: Locator;
  container?: Locator;
  strategy: AnswerOptionStrategy;
  count: number;
  counts: AnswerOptionCandidateCounts;
}

export interface ActualQuizEvidence {
  actualQuiz: boolean;
  quizContainer: boolean;
  submitVisible: boolean;
  nextQuestionVisible: boolean;
  quizHeadingVisible: boolean;
  questionTextVisible: boolean;
  completeAnswerTexts: boolean;
  genericAnnotationVisible: boolean;
  answerOptions: VisibleAnswerOptions;
}

export interface QuizEvidenceSummary {
  quizContainer: boolean;
  submitVisible: boolean;
  nextQuestionVisible: boolean;
  quizHeadingVisible: boolean;
  questionTextVisible: boolean;
  completeAnswerTexts: boolean;
  answerOptionCount: number;
}

export type QuizCandidateClassification = "actual" | "unsupported" | "non-quiz";

export interface QuizFingerprint {
  question: string;
  options: string[];
  signature: string;
  counter?: string;
}

export interface TransitionQuizFingerprint {
  fingerprint?: QuizFingerprint;
  optionCount: number;
  containerPresent: boolean;
}

export interface PostSubmitProbeResult {
  continueVisible: boolean;
  retryVisible: boolean;
  correctMarkerVisible: boolean;
  incorrectMarkerVisible: boolean;
  completionVisible: boolean;
  progressControlVisible: boolean;
  playbackResumed: boolean;
  quiz: TransitionQuizFingerprint;
}

export type PostSubmitProbe = () => Promise<PostSubmitProbeResult>;

export interface PostSubmitObserverClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface PostSubmitObservation {
  continueVisible: boolean;
  retryVisible: boolean;
  correctMarkerVisible: boolean;
  incorrectMarkerVisible: boolean;
  nextQuestionVisible: boolean;
  completionVisible: boolean;
  progressControlVisible: boolean;
  playbackResumed: boolean;
}

export interface QuizExtractionPolicy {
  attempts: number;
  attemptTimeoutMs: number;
  retryDelayMs: number;
  minimumOptionCount: number;
  maximumOptionCount: number;
}

export interface QuizExtractionDependencies {
  extract(page: Page, timeoutMs: number): Promise<QuizQuestion>;
  sleep(milliseconds: number): Promise<void>;
}

export interface QuizScreenshotOptions {
  timeoutMs: number;
  findPanel(page: Page): Promise<Locator | undefined>;
  save: typeof saveDiagnostic;
  exists(filePath: string): boolean;
  read(filePath: string): Buffer;
}

export function classifyPostSubmitObservation(observation: PostSubmitObservation): QuizOutcome {
  if (observation.continueVisible) return "correct";
  if (observation.retryVisible) return "incorrect";
  if (observation.completionVisible) return "completed";
  if (observation.nextQuestionVisible || observation.progressControlVisible || observation.playbackResumed) return "advanced";
  return "unknown";
}

const QUIZ_CONTAINER_SELECTOR = [
  '[class*="quiz-annotation__wrapper__"]:visible',
  '[class*="quiz-annotation__quiz-content__"]:visible',
  '[class*="quiz-annotation__options__wrapper__"]:visible',
  '[role="dialog"]:visible',
  'form:visible',
].join(", ");
const QUIZ_OPTION_CLASS_SELECTOR = '[class*="quiz-annotation__option__"]:visible';
const SEMANTIC_LABEL_SELECTOR = 'label:has(input[type="radio"], input[type="checkbox"]):visible';
const SEMANTIC_INPUT_SELECTOR = 'input[type="radio"]:visible, input[type="checkbox"]:visible';
const lastQuizDetectionLog = new WeakMap<Page, string>();
const unsupportedQuizCandidates = new WeakMap<Page, { signature: string; observations: number }>();

function validAnswerCount(count: number): boolean {
  return count >= QUIZ_MIN_OPTION_COUNT && count <= QUIZ_MAX_OPTION_COUNT;
}

export function chooseAnswerOptionStrategy(
  counts: AnswerOptionCandidateCounts,
): { strategy: AnswerOptionStrategy; count: number } {
  if (validAnswerCount(counts.roleSingle)) return { strategy: "role-single", count: counts.roleSingle };
  if (validAnswerCount(counts.semanticLabels)) return { strategy: "semantic-label", count: counts.semanticLabels };
  if (validAnswerCount(counts.semanticInputs)) return { strategy: "semantic-input", count: counts.semanticInputs };
  if (validAnswerCount(counts.quizOptionContainers)) {
    return { strategy: "quiz-option-class", count: counts.quizOptionContainers };
  }
  return { strategy: "none", count: 0 };
}

export function classifyQuizEvidence(evidence: QuizEvidenceSummary): QuizCandidateClassification {
  const quizIdentity = evidence.quizHeadingVisible || evidence.questionTextVisible;
  const progressionControl = evidence.submitVisible || evidence.nextQuestionVisible;
  if (!evidence.quizContainer || !quizIdentity || !progressionControl) return "non-quiz";
  if (validAnswerCount(evidence.answerOptionCount) && evidence.completeAnswerTexts) return "actual";
  return "unsupported";
}

function selectAnswerLocator(
  roleSingle: Locator,
  semanticLabels: Locator,
  semanticInputs: Locator,
  quizOptionContainers: Locator,
  counts: AnswerOptionCandidateCounts,
): { locator: Locator; strategy: AnswerOptionStrategy; count: number } {
  const selected = chooseAnswerOptionStrategy(counts);
  if (selected.strategy === "role-single") return { ...selected, locator: roleSingle };
  if (selected.strategy === "semantic-label") return { ...selected, locator: semanticLabels };
  if (selected.strategy === "semantic-input") return { ...selected, locator: semanticInputs };
  if (selected.strategy === "quiz-option-class") return { ...selected, locator: quizOptionContainers };
  return { ...selected, locator: roleSingle };
}

async function discoverAnswerOptionsWithin(scope: Page | Locator): Promise<Omit<VisibleAnswerOptions, "container">> {
  const roleSingle = scope.locator('[role="single"]:visible');
  const radioInputs = scope.locator('input[type="radio"]');
  const checkboxInputs = scope.locator('input[type="checkbox"]');
  const semanticLabels = scope.locator(SEMANTIC_LABEL_SELECTOR);
  const semanticInputs = scope.locator(SEMANTIC_INPUT_SELECTOR);
  const quizOptionContainers = scope.locator(QUIZ_OPTION_CLASS_SELECTOR);
  const [roleSingleCount, radioInputCount, checkboxInputCount, semanticLabelCount, semanticInputCount, optionContainerCount] = await Promise.all([
    roleSingle.count(),
    radioInputs.count(),
    checkboxInputs.count(),
    semanticLabels.count(),
    semanticInputs.count(),
    quizOptionContainers.count(),
  ]);
  const counts: AnswerOptionCandidateCounts = {
    roleSingle: roleSingleCount,
    radioInputs: radioInputCount,
    checkboxInputs: checkboxInputCount,
    semanticLabels: semanticLabelCount,
    semanticInputs: semanticInputCount,
    quizOptionContainers: optionContainerCount,
  };
  return { ...selectAnswerLocator(roleSingle, semanticLabels, semanticInputs, quizOptionContainers, counts), counts };
}

/**
 * Discovers clickable answer targets with Playwright locators so open shadow
 * roots are traversed consistently. It never waits for an expected count.
 */
export async function findVisibleAnswerOptions(page: Page): Promise<VisibleAnswerOptions> {
  const containers = page.locator(QUIZ_CONTAINER_SELECTOR);
  const containerCount = Math.min(await containers.count(), 20);
  for (let index = 0; index < containerCount; index += 1) {
    const container = containers.nth(index);
    const discovery = await discoverAnswerOptionsWithin(container);
    if (validAnswerCount(discovery.count)) return { ...discovery, container };
  }
  const discovery = await discoverAnswerOptionsWithin(page);
  return {
    ...discovery,
    ...(containerCount ? { container: containers.first() } : {}),
  };
}

export async function inspectActualQuizVisibility(page: Page): Promise<ActualQuizEvidence> {
  const answerOptions = await findVisibleAnswerOptions(page);
  const container = answerOptions.container;
  const scope: Page | Locator = container ?? page;
  const [submitVisible, nextQuestionVisible, quizHeadingVisible, questionTextVisible, genericAnnotationVisible, rawOptionTexts] = await Promise.all([
    scope.getByRole("button", { name: /^(?:submit|submit quiz|finish quiz)$/i }).filter({ visible: true }).first()
      .isVisible().catch(() => false),
    scope.getByRole("button", { name: /^(?:next question)$/i }).filter({ visible: true }).first()
      .isVisible().catch(() => false),
    scope.getByText(/(?:in-lesson quiz|end-of-lesson quiz|choose an answer|question\s+\d+\s+(?:out of|\/)\s+\d+)/i)
      .filter({ visible: true }).first().isVisible().catch(() => false),
    scope.locator('[class*="quiz-annotation__question__"]:visible, [data-testid*="question"]:visible, legend:visible')
      .first().isVisible().catch(() => false),
    page.locator(
      '[class*="button-annotation__wrapper__"]:visible, [class*="button-annotation__container__"]:visible, [class*="image-annotation"]:visible, [class*="text-annotation"]:visible',
    ).first().isVisible().catch(() => false),
    answerOptions.locator.allInnerTexts().catch(() => [] as string[]),
  ]);
  const quizContainer = Boolean(container);
  const completeAnswerTexts = cleanOptionTexts(rawOptionTexts).length === answerOptions.count;
  const classification = classifyQuizEvidence({
    quizContainer,
    submitVisible,
    nextQuestionVisible,
    quizHeadingVisible,
    questionTextVisible,
    completeAnswerTexts,
    answerOptionCount: answerOptions.count,
  });
  return {
    actualQuiz: classification === "actual",
    quizContainer,
    submitVisible,
    nextQuestionVisible,
    quizHeadingVisible,
    questionTextVisible,
    completeAnswerTexts,
    genericAnnotationVisible,
    answerOptions,
  };
}

function logQuizEvidence(page: Page, evidence: ActualQuizEvidence, logger?: Pick<Logger, "info" | "debug">): void {
  if (!logger) return;
  const { counts } = evidence.answerOptions;
  const signature = JSON.stringify({
    actualQuiz: evidence.actualQuiz,
    quizContainer: evidence.quizContainer,
    submitVisible: evidence.submitVisible,
    nextQuestionVisible: evidence.nextQuestionVisible,
    quizHeadingVisible: evidence.quizHeadingVisible,
    questionTextVisible: evidence.questionTextVisible,
    completeAnswerTexts: evidence.completeAnswerTexts,
    genericAnnotationVisible: evidence.genericAnnotationVisible,
    strategy: evidence.answerOptions.strategy,
    counts,
  });
  if (lastQuizDetectionLog.get(page) === signature) return;
  lastQuizDetectionLog.set(page, signature);
  const details = [
    `quiz container=${evidence.quizContainer ? "yes" : "no"}`,
    `Submit visible=${evidence.submitVisible ? "yes" : "no"}`,
    `Next Question visible=${evidence.nextQuestionVisible ? "yes" : "no"}`,
    `question text=${evidence.questionTextVisible || evidence.quizHeadingVisible ? "yes" : "no"}`,
    `complete answer text=${evidence.completeAnswerTexts ? "yes" : "no"}`,
    `role=single: ${counts.roleSingle}`,
    `radio inputs: ${counts.radioInputs}`,
    `checkbox inputs: ${counts.checkboxInputs}`,
    `semantic labels: ${counts.semanticLabels}`,
    `candidate option containers: ${counts.quizOptionContainers}`,
    `selected strategy=${evidence.answerOptions.strategy}`,
  ].join("; ");
  if (evidence.actualQuiz) logger.info("QUIZ", `Candidate detected: ${details}`);
  else if (evidence.genericAnnotationVisible && !evidence.quizContainer) {
    logger.info("QUIZ", `Player annotation detected but no answerable quiz controls; ignoring as non-quiz. ${details}`);
  } else if (evidence.quizContainer) {
    logger.info("QUIZ", `Quiz-like container is not yet answerable; waiting. ${details}`);
  } else {
    logger.debug("QUIZ", `No answerable quiz visible. ${details}`);
  }
}

function cleanOptionTexts(optionTexts: readonly string[]): string[] {
  return optionTexts.map((raw) => normalizeText(raw).replace(/^\s*[a-hA-H][).:]\s*/u, ""))
    .map(normalizeText)
    .filter(Boolean);
}

const ROMAN_STATEMENT_LABELS = ["I", "II", "III", "IV", "V", "VI"] as const;
const NUMERIC_STATEMENT_LABELS = ["1", "2", "3", "4", "5", "6"] as const;
const LETTER_STATEMENT_LABELS = ["A", "B", "C", "D", "E", "F"] as const;

function extractLabelReferences(text: string, labels: readonly string[]): string[] {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const matches = text.match(new RegExp(`\\b(?:${escaped})\\b`, "giu")) ?? [];
  return [...new Set(matches.map((match) => match.toUpperCase()))];
}

function combinationLabelsFromOptions(options: readonly string[]): string[] | undefined {
  for (const labels of [ROMAN_STATEMENT_LABELS, NUMERIC_STATEMENT_LABELS, LETTER_STATEMENT_LABELS]) {
    const references = options.map((option) => extractLabelReferences(option, labels));
    const combined = [...new Set(references.flat())];
    if (combined.length >= 2 && references.some((entry) => entry.length >= 2)) {
      return labels.filter((label) => combined.includes(label));
    }
  }
  return undefined;
}

function extractStatementsFromCandidate(
  candidate: string,
  labels: readonly string[],
): CombinationStatement[] {
  const normalized = candidate.replace(/\r?\n/gu, "\n").replace(/[\t\f\v ]+/gu, " ").trim();
  if (!normalized) return [];
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  const marker = `(?:${escaped})`;
  const pattern = new RegExp(
    `(?:^|\\s)(${marker})\\s*[).:।-]\\s*([\\s\\S]*?)(?=(?:\\s+(?:${marker})\\s*[).:।-])|$)`,
    "giu",
  );
  const statements: CombinationStatement[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const label = match[1]?.toUpperCase();
    const text = normalizeText(match[2] ?? "");
    if (label && text.length > 1) statements.push({ label, text });
  }
  return statements;
}

export function detectCombinationQuestion(
  question: string,
  options: readonly string[],
  statementCandidates: readonly string[] = [],
): CombinationQuestionContext | undefined {
  const referencedLabels = combinationLabelsFromOptions(options);
  if (!referencedLabels) return undefined;
  const statementsByLabel = new Map<string, CombinationStatement>();
  const candidates = [question, ...statementCandidates].filter(Boolean);
  for (const candidate of candidates) {
    for (const statement of extractStatementsFromCandidate(candidate, referencedLabels)) {
      if (referencedLabels.includes(statement.label) && !statementsByLabel.has(statement.label)) {
        statementsByLabel.set(statement.label, statement);
      }
    }
  }
  const statements = referencedLabels.flatMap((label) => {
    const statement = statementsByLabel.get(label);
    return statement ? [statement] : [];
  });
  return {
    referencedLabels,
    statements,
    requiresVisual: statements.length !== referencedLabels.length,
  };
}

export function formatCombinationStatements(combination: CombinationQuestionContext): string {
  return combination.statements.map((statement) => `${statement.label}. ${statement.text}`).join("\n");
}

async function findQuizContentScope(page: Page, fallback: Locator | undefined): Promise<Locator> {
  const candidates = page.locator([
    '[class*="quiz-annotation__wrapper__"]:visible',
    '[class*="quiz-annotation__quiz-content__"]:visible',
    '[role="dialog"]:visible',
    'form:visible',
  ].join(", "));
  const candidateCount = Math.min(await candidates.count(), 10);
  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = candidates.nth(index);
    const discovery = await discoverAnswerOptionsWithin(candidate);
    if (validAnswerCount(discovery.count)) return candidate;
  }
  return fallback ?? page.locator("body");
}

const STATEMENT_CANDIDATE_SELECTOR = [
  '[class*="quiz-annotation__question__"]:visible',
  '[class*="quiz-annotation__description__"]:visible',
  '[class*="question"]:visible',
  '[data-testid*="question"]:visible',
  'ol:visible',
  'ul:visible',
  'li:visible',
  'table:visible',
  'tr:visible',
  'td:visible',
  'th:visible',
  'p:visible',
  'mjx-container:visible',
  '.MathJax:visible',
  '[class*="mathjax"]:visible',
  '[class*="MathJax"]:visible',
  'svg text:visible',
].join(", ");

export async function readQuizDomSnapshot(page: Page): Promise<QuizDomSnapshot> {
  try {
    const answerOptions = await findVisibleAnswerOptions(page);
    const root = await findQuizContentScope(page, answerOptions.container);
    const [rawOptions, preferredTexts, panelTexts, statementCandidates, meaningfulVisual] = await Promise.all([
      answerOptions.locator.allInnerTexts(),
      root.locator(
        '[class*="quiz-annotation__question__"]:visible, [data-testid*="question"]:visible, h1:visible, h2:visible, h3:visible, h4:visible, legend:visible',
      ).allInnerTexts(),
      root.allInnerTexts(),
      root.locator(STATEMENT_CANDIDATE_SELECTOR).allInnerTexts(),
      root.locator('img:visible, svg:visible, canvas:visible, figure:visible, [style*="background-image"]:visible')
        .evaluateAll((nodes) => nodes.some((node) => {
          if (node.closest(
            '[role="single"], [class*="quiz-annotation__option__"], button, [role="button"], [class*="button-annotation"], [class*="controlbar"]',
          )) return false;
          const rect = node.getBoundingClientRect();
          const tag = node.tagName.toLowerCase();
          const minimumWidth = tag === "svg" ? 120 : 100;
          const minimumHeight = tag === "svg" ? 80 : 72;
          if (rect.width < minimumWidth || rect.height < minimumHeight) return false;
          const description = `${node.getAttribute("alt") ?? ""} ${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("class") ?? ""}`.toLowerCase();
          return !/logo|brand|pedagogy|avatar|icon|spinner|loader|thumbnail/.test(description);
        })),
    ]);
    const options = cleanOptionTexts(rawOptions);
    const panelText = panelTexts.join("\n");
    const counter = panelText.match(
      /Question\s+\d+\s+(?:out\s+of|\/)\s+\d+|Answered\s+\d+\s*\/\s*\d+/i,
    )?.[0];
    return {
      options,
      preferredTexts: preferredTexts.map(normalizeText).filter((text) => text.length > 2),
      panelText,
      ...(counter ? { counter } : {}),
      containerPresent: Boolean(answerOptions.container),
      meaningfulVisual,
      optionTargetCount: answerOptions.count,
      answerCandidates: answerOptions.counts,
      statementCandidates: [...new Set(statementCandidates.map(normalizeText).filter((text) => text.length > 1))],
    };
  } catch {
    return {
      options: [],
      preferredTexts: [],
      panelText: "",
      containerPresent: false,
      meaningfulVisual: false,
    };
  }
}

export function fingerprintQuizSnapshot(snapshot: QuizDomSnapshot): QuizFingerprint | undefined {
  if (snapshot.options.length < 2 || snapshot.options.some((option) => !option)) return undefined;
  const question = selectQuestionText(snapshot.preferredTexts, snapshot.panelText, snapshot.options);
  return {
    question,
    options: [...snapshot.options],
    signature: stableQuestionHash(question, snapshot.options),
    ...(snapshot.counter ? { counter: normalizeText(snapshot.counter) } : {}),
  };
}

export function quizFingerprintChanged(previous: QuizFingerprint, current: QuizFingerprint | undefined): boolean {
  if (!current) return false;
  if (current.signature !== previous.signature) return true;
  return Boolean(previous.counter && current.counter && previous.counter !== current.counter);
}

/**
 * Reads only the DOM that exists at this instant. It never waits for option
 * locators and returns an incomplete observation while React replaces a quiz.
 */
export async function tryGetQuizFingerprint(page: Page): Promise<TransitionQuizFingerprint> {
  const snapshot = await withStageTimeout(
    "post-submit quiz fingerprint probe",
    QUIZ_STAGE_TIMEOUTS.postSubmitProbe,
    () => readQuizDomSnapshot(page),
  ).catch(() => ({
    options: [],
    preferredTexts: [],
    panelText: "",
    containerPresent: false,
    meaningfulVisual: false,
  }));
  const fingerprint = fingerprintQuizSnapshot(snapshot);
  return {
    ...(fingerprint ? { fingerprint } : {}),
    optionCount: snapshot.options.length,
    containerPresent: snapshot.containerPresent,
  };
}

export async function waitForQuiz(
  page: Page,
  timeout = 1000,
  logger?: Pick<Logger, "info" | "debug">,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let lastEvidence: ActualQuizEvidence | undefined;
  do {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const evidence = await withStageTimeout(
        "actual quiz detection",
        remaining,
        () => inspectActualQuizVisibility(page),
      );
      lastEvidence = evidence;
      if (evidence.actualQuiz) {
        unsupportedQuizCandidates.delete(page);
        logQuizEvidence(page, evidence, logger);
        return true;
      }
    } catch {
      break;
    }
    if (Date.now() < deadline) await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (lastEvidence) {
    logQuizEvidence(page, lastEvidence, logger);
    const classification = classifyQuizEvidence({
      quizContainer: lastEvidence.quizContainer,
      submitVisible: lastEvidence.submitVisible,
      nextQuestionVisible: lastEvidence.nextQuestionVisible,
      quizHeadingVisible: lastEvidence.quizHeadingVisible,
      questionTextVisible: lastEvidence.questionTextVisible,
      completeAnswerTexts: lastEvidence.completeAnswerTexts,
      answerOptionCount: lastEvidence.answerOptions.count,
    });
    if (classification === "unsupported") {
      const signature = JSON.stringify({
        strategy: lastEvidence.answerOptions.strategy,
        counts: lastEvidence.answerOptions.counts,
      });
      const previous = unsupportedQuizCandidates.get(page);
      const observations = previous?.signature === signature ? previous.observations + 1 : 1;
      unsupportedQuizCandidates.set(page, { signature, observations });
      if (observations >= QUIZ_EXTRACTION_ATTEMPTS) {
        const counts = lastEvidence.answerOptions.counts;
        throw new AutomationPauseError(
          `A genuine quiz container remained visible for ${observations} bounded checks, but its answer controls are unsupported or incomplete. `
          + `role=single: ${counts.roleSingle}; radio inputs: ${counts.radioInputs}; checkbox inputs: ${counts.checkboxInputs}; `
          + `semantic labels: ${counts.semanticLabels}; candidate option containers: ${counts.quizOptionContainers}.`,
        );
      }
    } else {
      unsupportedQuizCandidates.delete(page);
    }
  }
  return false;
}

export function selectQuestionText(
  preferredTexts: readonly string[],
  panelText: string,
  options: readonly string[],
): string {
  const normalizedOptions = new Set(options.map(normalizeText));
  const lineCandidates = panelText.split(/\r?\n/u).map(normalizeText);
  const candidates = [...preferredTexts.map(normalizeText), ...lineCandidates]
    .filter((text) => text.length > 2)
    .filter((text) => !normalizedOptions.has(text.replace(/^\s*[a-hA-H][).:]\s*/u, "")))
    .filter((text) => !/^(?:question\s+\d+\s+out\s+of\s+\d+|choose an answer|end-?lesson quiz|submit|previous question|next question|finish quiz|answered\s+\d+\s*\/\s*\d+|\d+%.*)$/iu.test(text));

  const unique = [...new Set(candidates)];
  return unique.sort((left, right) => {
    const score = (text: string): number => {
      const questionMark = /[?？]/u.test(text) ? 10_000 : 0;
      const preferred = preferredTexts.some((candidate) => normalizeText(candidate) === text) ? 1_000 : 0;
      return questionMark + preferred + Math.min(text.length, 500);
    };
    return score(right) - score(left);
  })[0] ?? "";
}

export async function extractLessonContext(
  page: Page,
  timeoutMs: number = QUIZ_STAGE_TIMEOUTS.lessonContext,
): Promise<string | undefined> {
  return withStageTimeout("lesson context extraction", timeoutMs, async () => {
    const pageTitle = normalizeText(await page.title().catch(() => ""));
    const lines = await page.locator("body").innerText({ timeout: Math.min(2_000, timeoutMs) })
      .then((text) => text.split(/\r?\n/u))
      .catch(() => [] as string[]);
    const relevant = lines.map(normalizeText).filter((line) =>
      /^Unit\s+\d+\s*:/iu.test(line)
      || /^[०-९\d]+(?:[.।][०-९\d]+)?\s*-\s*\S+/u.test(line));
    const context = [...new Set([pageTitle, ...relevant].filter(Boolean))].slice(0, 3);
    return context.length ? context.join(" | ") : undefined;
  });
}

async function quizPanel(page: Page): Promise<Locator | undefined> {
  const answerOptions = await findVisibleAnswerOptions(page);
  const panel = await findQuizContentScope(page, answerOptions.container);
  return await panel.isVisible().catch(() => false) ? panel : answerOptions.container;
}

export async function extractQuiz(
  page: Page,
  timeoutMs: number = QUIZ_STAGE_TIMEOUTS.domSnapshot,
): Promise<QuizQuestion> {
  const snapshot = await withStageTimeout(
    "quiz DOM extraction",
    timeoutMs,
    () => readQuizDomSnapshot(page),
  );
  return quizQuestionFromSnapshot(snapshot);
}

export function quizQuestionFromSnapshot(snapshot: QuizDomSnapshot): QuizQuestion {
  const options = snapshot.options;
  const question = selectQuestionText(snapshot.preferredTexts, snapshot.panelText, options);
  const optionTargetCount = snapshot.optionTargetCount ?? options.length;
  const combination = detectCombinationQuestion(
    question,
    options,
    [
      ...snapshot.preferredTexts,
      snapshot.panelText,
      ...(snapshot.statementCandidates ?? []),
    ],
  );
  const completeText = normalizeText(question).length >= 4
    && validAnswerCount(options.length)
    && options.length === optionTargetCount
    && options.every((option) => option.length > 0);
  return {
    question: normalizeText(question),
    options,
    visual: snapshot.meaningfulVisual || !completeText || Boolean(combination?.requiresVisual),
    completeText,
    optionTargetCount,
    ...(combination ? { combination } : {}),
  };
}

export async function extractQuizWithRetry(
  page: Page,
  logger: Pick<Logger, "info" | "warn">,
  scope: string,
  policy: Partial<QuizExtractionPolicy> = {},
  dependencies: Partial<QuizExtractionDependencies> = {},
): Promise<QuizQuestion> {
  const resolvedPolicy: QuizExtractionPolicy = {
    attempts: QUIZ_EXTRACTION_ATTEMPTS,
    attemptTimeoutMs: QUIZ_STAGE_TIMEOUTS.domSnapshot,
    retryDelayMs: QUIZ_EXTRACTION_RETRY_MS,
    minimumOptionCount: QUIZ_MIN_OPTION_COUNT,
    maximumOptionCount: QUIZ_MAX_OPTION_COUNT,
    ...policy,
  };
  const extract = dependencies.extract ?? extractQuiz;
  const delay = dependencies.sleep ?? sleep;
  let lastProblem = "quiz options did not finish rendering";
  let visualFallbackQuiz: QuizQuestion | undefined;

  for (let attempt = 1; attempt <= resolvedPolicy.attempts; attempt += 1) {
    logger.info(scope, `Extracting quiz DOM (attempt ${attempt}/${resolvedPolicy.attempts})...`);
    try {
      const quiz = await withStageTimeout(
        "quiz DOM extraction",
        resolvedPolicy.attemptTimeoutMs,
        () => extract(page, resolvedPolicy.attemptTimeoutMs),
        (elapsedMs) => logger.info(
          scope,
          `Still waiting for quiz DOM to stabilize... ${Math.max(1, Math.round(elapsedMs / 1_000))}s`,
        ),
      );
      logger.info(scope, "Reading question text from current DOM snapshot...");
      logger.info(scope, `Reading answer options... ${quiz.options.length} currently visible`);
      logger.info(scope, `Detecting visual content... ${quiz.visual ? "visual content present" : "text-only question"}`);
      const optionTargetCount = quiz.optionTargetCount ?? quiz.options.length;
      if (quiz.options.length >= resolvedPolicy.minimumOptionCount
        && quiz.options.length <= resolvedPolicy.maximumOptionCount
        && quiz.options.length === optionTargetCount
        && quiz.options.every((option) => normalizeText(option).length > 0)) {
        if (quiz.combination) {
          logger.info(scope, "Combination question detected");
          logger.info(scope, `Referenced statements: ${quiz.combination.referencedLabels.join(", ")}`);
          logger.info(
            scope,
            `Extracted statements: ${quiz.combination.statements.length}/${quiz.combination.referencedLabels.length}`,
          );
          if (quiz.combination.requiresVisual) {
            visualFallbackQuiz = quiz;
            lastProblem = "combination statements are missing from the DOM";
            logger.info(scope, "Statements missing from DOM; using visual extraction");
            if (attempt < resolvedPolicy.attempts) {
              logger.info(scope, `Retrying enhanced statement extraction in ${resolvedPolicy.retryDelayMs}ms`);
              await delay(resolvedPolicy.retryDelayMs);
              continue;
            }
            logger.info(scope, "Quiz extraction complete with required visual statement fallback");
            return visualFallbackQuiz;
          }
        }
        logger.info(scope, "Quiz extraction complete");
        return quiz;
      }
      const discovery = await findVisibleAnswerOptions(page).catch(() => undefined);
      if (discovery) {
        const counts = discovery.counts;
        logger.warn(
          scope,
          `Answer candidates: role=single: ${counts.roleSingle}; radio inputs: ${counts.radioInputs}; checkbox inputs: ${counts.checkboxInputs}; semantic labels: ${counts.semanticLabels}; candidate option containers: ${counts.quizOptionContainers}; strategy=${discovery.strategy}`,
        );
      }
      lastProblem = `found ${quiz.options.length} complete answer texts for ${optionTargetCount} clickable targets; expected ${resolvedPolicy.minimumOptionCount}-${resolvedPolicy.maximumOptionCount} complete choices`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }

    logger.warn(scope, `Quiz DOM is still rendering on attempt ${attempt}/${resolvedPolicy.attempts}: ${lastProblem}`);
    if (attempt < resolvedPolicy.attempts) {
      logger.info(scope, `Retrying whole extraction from fresh locators in ${resolvedPolicy.retryDelayMs}ms`);
      await delay(resolvedPolicy.retryDelayMs);
    }
  }

  if (visualFallbackQuiz) return visualFallbackQuiz;

  throw new Error(
    `Quiz extraction failed after ${resolvedPolicy.attempts} bounded attempts. Last issue: ${lastProblem}.`,
  );
}

export async function captureQuizScreenshot(
  page: Page,
  config: AppConfig,
  logger: Logger,
  label = "visual-question",
  options: Partial<QuizScreenshotOptions> = {},
): Promise<{ path: string; hash: string }> {
  const timeoutMs = options.timeoutMs ?? QUIZ_STAGE_TIMEOUTS.screenshot;
  const findPanel = options.findPanel ?? quizPanel;
  const save = options.save ?? saveDiagnostic;
  const exists = options.exists ?? fs.existsSync;
  const read = options.read ?? ((filePath: string) => fs.readFileSync(filePath));
  return withStageTimeout("visual quiz screenshot", timeoutMs, async () => {
    const panel = await findPanel(page);
    const screenshotPath = await save(
      page,
      config.screenshotsDir,
      logger,
      label,
      panel,
      timeoutMs,
    );
    if (!exists(screenshotPath)) throw new Error("Visual quiz screenshot was not created.");
    const bytes = read(screenshotPath);
    return { path: screenshotPath, hash: bufferHash(bytes) };
  });
}

async function selectAnswer(page: Page, decision: AnswerDecision, logger: Logger): Promise<void> {
  const discovery = await findVisibleAnswerOptions(page);
  const choices = discovery.locator;
  if (decision.answerIndex < 0 || decision.answerIndex >= discovery.count) {
    throw new Error(`Answer index ${decision.answerIndex} is outside the visible option range.`);
  }
  const option = choices.nth(decision.answerIndex);
  await option.scrollIntoViewIfNeeded();
  await option.click();
  const selected = await option.evaluate((element) => {
    const input = element.matches('input[type="radio"], input[type="checkbox"]')
      ? element as HTMLInputElement
      : element.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');
    const className = element.getAttribute("class") ?? "";
    return /selected/i.test(className)
      || element.getAttribute("aria-checked") === "true"
      || Boolean(input?.checked);
  });
  if (!selected) throw new Error(`Option ${decision.answerLabel} did not become selected.`);
  logger.info("QUIZ", `Selected ${decision.answerLabel} using ${discovery.strategy}`);
}

async function submitAnswer(page: Page, logger: Logger): Promise<void> {
  const submit = page.getByRole("button", {
    name: /^(submit|next question|finish quiz|submit quiz)$/i,
  }).filter({ visible: true }).first();
  await submit.waitFor({ state: "visible", timeout: QUIZ_STAGE_TIMEOUTS.interaction });
  const label = normalizeText(await submit.innerText());
  await submit.click();
  logger.info("QUIZ", `Submitted answer with ${label}`);
}

export async function observePostSubmitStateWithProbe(
  previousFingerprint: QuizFingerprint,
  timeout: number,
  logger: Pick<Logger, "info">,
  probe: PostSubmitProbe,
  clock: PostSubmitObserverClock = { now: Date.now, sleep },
): Promise<QuizOutcome> {
  const deadline = clock.now() + timeout;
  let disappearanceLogged = false;
  let correctMarkerLogged = false;
  let incorrectMarkerLogged = false;
  let delayedProbeLogged = false;
  logger.info("QUIZ", "Waiting for post-submit state...");
  while (clock.now() < deadline) {
    const remainingMs = Math.max(1, deadline - clock.now());
    let state: PostSubmitProbeResult;
    try {
      state = await withStageTimeout(
        "post-submit state probe",
        Math.min(QUIZ_STAGE_TIMEOUTS.postSubmitProbe, remainingMs),
        probe,
      );
    } catch (error) {
      if (!delayedProbeLogged) {
        logger.info("QUIZ", `Post-submit probe was delayed; continuing within the ${timeout}ms result deadline`);
        delayedProbeLogged = true;
      }
      if (error instanceof QuizStageTimeoutError) continue;
      throw error;
    }
    if (state.continueVisible) {
      logger.info("QUIZ", "Continue state detected");
      return "correct";
    }
    if (state.retryVisible) {
      logger.info("QUIZ", "Retry state detected");
      return "incorrect";
    }
    if (state.correctMarkerVisible && !correctMarkerLogged) {
      logger.info("QUIZ", "Correct result marker detected; waiting for actionable post-submit state");
      correctMarkerLogged = true;
    }
    if (state.incorrectMarkerVisible && !incorrectMarkerLogged) {
      logger.info("QUIZ", "Incorrect result marker detected; waiting for actionable post-submit state");
      incorrectMarkerLogged = true;
    }
    if (state.completionVisible) {
      logger.info("QUIZ", "Quiz completion state detected");
      return "completed";
    }
    if (state.quiz.optionCount < 2 && !disappearanceLogged) {
      logger.info("QUIZ", "Previous quiz DOM disappeared");
      disappearanceLogged = true;
    }
    const nextQuestionVisible = quizFingerprintChanged(previousFingerprint, state.quiz.fingerprint);
    if (nextQuestionVisible) {
      logger.info("QUIZ", "New quiz question detected; previous answer submitted");
      return "advanced";
    }
    const outcome = classifyPostSubmitObservation({
      continueVisible: state.continueVisible,
      retryVisible: state.retryVisible,
      correctMarkerVisible: state.correctMarkerVisible,
      incorrectMarkerVisible: state.incorrectMarkerVisible,
      nextQuestionVisible,
      completionVisible: state.completionVisible,
      progressControlVisible: state.progressControlVisible,
      playbackResumed: state.playbackResumed,
    });
    if (outcome !== "unknown") {
      logger.info("QUIZ", "Post-submit transition detected");
      return outcome;
    }
    await clock.sleep(250);
  }
  return "unknown";
}

export async function observePostSubmitState(
  page: Page,
  previousFingerprint: QuizFingerprint,
  timeout: number,
  logger: Pick<Logger, "info">,
): Promise<QuizOutcome> {
  const video = page.locator("video:visible").first();
  const initialVideoTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime).catch(() => undefined);
  const probe: PostSubmitProbe = async () => {
    const continueVisible = await playerAnnotationLocator(page, "continue").isVisible().catch(() => false);
    const retryVisible = await playerAnnotationLocator(page, "retry").isVisible().catch(() => false);
    const correctMarkerVisible = await page.getByText(
      /^(?:correct|correct answer|well done|you are correct|सही|सही उत्तर)[!.\s]*$/i,
    ).filter({ visible: true }).first().isVisible().catch(() => false);
    const incorrectMarkerVisible = await page.getByText(
      /^(?:incorrect|wrong|wrong answer|try again|you are incorrect|गलत|गलत उत्तर)[!.\s]*$/i,
    ).filter({ visible: true }).first().isVisible().catch(() => false);
    const completionVisible = await page.getByText(
      /End-of-Lesson Quiz (?:Completed|Complete)|Thank you for completing this video|Quiz (?:Completed|Complete)|Congratulations|Your (?:score|result)/i,
    ).filter({ visible: true }).first().isVisible().catch(() => false);
    const progressControlVisible = await page.getByRole("button", {
      name: /^(next|next question|finish|finish quiz|done|complete|continue)$/i,
    }).filter({ visible: true }).first().isVisible().catch(() => false);
    const quiz = await tryGetQuizFingerprint(page);
    const playback = await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      return { paused: media.paused, currentTime: media.currentTime };
    }).catch(() => undefined);
    const playbackResumed = quiz.optionCount < 2 && playback?.paused === false
      && (initialVideoTime === undefined || playback.currentTime > initialVideoTime + 0.1);
    return {
      continueVisible,
      retryVisible,
      correctMarkerVisible,
      incorrectMarkerVisible,
      completionVisible,
      progressControlVisible,
      playbackResumed,
      quiz,
    };
  };
  return observePostSubmitStateWithProbe(previousFingerprint, timeout, logger, probe);
}

async function chooseAnswer(
  quiz: QuizQuestion,
  attempted: Set<number>,
  cacheKey: string,
  screenshotPath: string | undefined,
  answerProvider: AnswerProvider,
  cache: AnswerCache,
  logger: Logger,
  lessonContext: string | undefined,
  processingId?: string,
): Promise<AnswerDecision> {
  const answerScope = processingId ? `ANSWER:${processingId}` : "ANSWER";
  const request: AnswerRequest = {
    quiz,
    attemptedAnswerIndexes: [...attempted],
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(lessonContext ? { lessonContext } : {}),
    ...(processingId ? { processingId } : {}),
  };
  validateAnswerRequestCompleteness(request);
  const cached = cache.get(cacheKey);
  if (cached && cached.answerIndex < quiz.options.length && !attempted.has(cached.answerIndex)) {
    try {
      const validated = validateAnswerDecision(cached, request);
      logger.info(answerScope, `Using cached answer ${validated.answerLabel}`);
      return validated;
    } catch {
      cache.delete(cacheKey);
      logger.warn(answerScope, "Discarded a legacy or inconsistent cached answer");
    }
  }
  const decision = validateAnswerDecision(await answerProvider.answer(request), request);
  logger.info(
    answerScope,
    `${answerProvider.id} selected ${decision.answerLabel} (confidence ${decision.confidence.toFixed(2)}): ${decision.reason}`,
  );
  return decision;
}

export async function pauseAfterQuizStageFailure(
  page: Page,
  config: AppConfig,
  logger: Logger,
  scope: string,
  processingId: string,
  stage: string,
  error: unknown,
  diagnosticSaver: typeof saveDiagnostic = saveDiagnostic,
): Promise<never> {
  const problem = error instanceof Error ? error.message : String(error);
  logger.error(scope, `${stage} failed: ${problem}`);
  try {
    await withStageTimeout(
      "quiz failure diagnostics",
      QUIZ_STAGE_TIMEOUTS.diagnostics,
      () => diagnosticSaver(
        page,
        config.screenshotsDir,
        logger,
        `${processingId}-${stage}-failed`,
        undefined,
        QUIZ_STAGE_TIMEOUTS.diagnostics,
      ),
      (elapsedMs) => logger.info(scope, `Still saving failure diagnostics... ${Math.round(elapsedMs / 1_000)}s`),
    );
  } catch (diagnosticError) {
    logger.warn(scope, `Failure diagnostics did not finish: ${String(diagnosticError)}`);
  }
  throw new AutomationPauseError(
    `${stage} failed safely for ${processingId}; no answer was clicked. ${problem}`,
  );
}

export async function solveActiveQuiz(
  page: Page,
  answerProvider: AnswerProvider,
  cache: AnswerCache,
  config: AppConfig,
  logger: Logger,
  kind: "in-lesson" | "end-of-lesson",
): Promise<void> {
  logger.info("QUIZ", `${kind === "in-lesson" ? "In-lesson" : "End-of-lesson"} quiz detected`);
  const processingId = nextQuizProcessingId();
  const quizScope = `QUIZ:${processingId}`;
  const answerScope = `ANSWER:${processingId}`;
  logger.info(quizScope, `Detected (${kind})`);
  const attempted = new Set<number>();
  let lessonContext: string | undefined;
  logger.info(quizScope, "Reading lesson context...");
  try {
    lessonContext = await withStageTimeout(
      "lesson context extraction",
      QUIZ_STAGE_TIMEOUTS.lessonContext,
      () => extractLessonContext(page, QUIZ_STAGE_TIMEOUTS.lessonContext),
      (elapsedMs) => logger.info(quizScope, `Still reading lesson context... ${Math.round(elapsedMs / 1_000)}s`),
    );
    logger.info(quizScope, lessonContext ? "Lesson context captured" : "No lesson context found; continuing");
  } catch (error) {
    logger.warn(quizScope, `Lesson context unavailable within ${QUIZ_STAGE_TIMEOUTS.lessonContext}ms; continuing without it: ${String(error)}`);
  }

  while (true) {
    let quiz: QuizQuestion;
    try {
      quiz = await extractQuizWithRetry(page, logger, quizScope);
    } catch (error) {
      return pauseAfterQuizStageFailure(
        page,
        config,
        logger,
        quizScope,
        processingId,
        "quiz-extraction",
        error,
      );
    }
    logger.info(quizScope, `Question: ${quiz.question || "[visual question]"}`);
    quiz.options.forEach((option, index) => logger.info(quizScope, `${answerLabel(index)}: ${option}`));

    let screenshotPath: string | undefined;
    let visualHash = "";
    if (quiz.visual) {
      logger.info(quizScope, "Capturing visual question...");
      try {
        const captured = await withStageTimeout(
          "visual quiz screenshot",
          QUIZ_STAGE_TIMEOUTS.screenshot,
          () => captureQuizScreenshot(page, config, logger, `${processingId}-visual-question`),
          (elapsedMs) => logger.info(quizScope, `Still capturing visual question... ${Math.round(elapsedMs / 1_000)}s`),
        );
        screenshotPath = captured.path;
        visualHash = captured.hash;
        logger.info(quizScope, `Visual question captured: ${path.basename(screenshotPath)}`);
      } catch (error) {
        return pauseAfterQuizStageFailure(
          page,
          config,
          logger,
          quizScope,
          processingId,
          "visual-capture",
          error,
        );
      }
    }
    const combinationKey = quiz.combination
      ? `${quiz.combination.referencedLabels.join(",")}\n${formatCombinationStatements(quiz.combination)}\n${quiz.combination.requiresVisual}`
      : "";
    const baseKey = stableQuestionHash(quiz.question, quiz.options, `${visualHash}\n${combinationKey}`);
    if (attempted.size >= quiz.options.length) throw new Error("No untried answers remain for this question.");
    logger.info(answerScope, "Sending question to provider...");
    const decision = await chooseAnswer(
      quiz,
      attempted,
      baseKey,
      screenshotPath,
      answerProvider,
      cache,
      logger,
      lessonContext,
      processingId,
    );
    logger.info(quizScope, `Selecting answer ${decision.answerLabel}...`);
    try {
      await withStageTimeout(
        "quiz answer selection",
        QUIZ_STAGE_TIMEOUTS.interaction,
        () => selectAnswer(page, decision, logger),
      );
    } catch (error) {
      return pauseAfterQuizStageFailure(
        page,
        config,
        logger,
        quizScope,
        processingId,
        "answer-selection",
        error,
      );
    }
    logger.info(quizScope, "Capturing pre-submit question fingerprint...");
    const beforeSubmitSnapshot = await withStageTimeout(
      "pre-submit question fingerprint",
      QUIZ_STAGE_TIMEOUTS.domSnapshot,
      () => readQuizDomSnapshot(page),
    ).catch((error) => {
      logger.warn(quizScope, `Pre-submit DOM fingerprint was delayed; using extracted question data: ${String(error)}`);
      return undefined;
    });
    const previousFingerprint = (beforeSubmitSnapshot ? fingerprintQuizSnapshot(beforeSubmitSnapshot) : undefined) ?? {
      question: quiz.question,
      options: [...quiz.options],
      signature: stableQuestionHash(quiz.question, quiz.options),
      ...(beforeSubmitSnapshot?.counter ? { counter: normalizeText(beforeSubmitSnapshot.counter) } : {}),
    };
    logger.info(quizScope, "Submitting selected answer...");
    try {
      await withStageTimeout(
        "quiz answer submission",
        QUIZ_STAGE_TIMEOUTS.interaction,
        () => submitAnswer(page, logger),
      );
    } catch (error) {
      return pauseAfterQuizStageFailure(
        page,
        config,
        logger,
        quizScope,
        processingId,
        "answer-submission",
        error,
      );
    }
    const outcome = await observePostSubmitState(page, previousFingerprint, config.MST_RESULT_TIMEOUT_MS, logger);

    if (outcome === "correct") {
      cache.set(baseKey, decision);
      logger.info("QUIZ", "Correct");
      await clickPlayerAnnotation(page, "continue", config, logger);
      return;
    }
    if (outcome === "incorrect") {
      attempted.add(decision.answerIndex);
      cache.delete(baseKey);
      logger.warn("QUIZ", "Incorrect");
      logger.warn("QUIZ", `${decision.answerLabel} was incorrect; retrying without that option`);
      await clickPlayerAnnotation(page, "retry", config, logger);
      continue;
    }
    if (outcome === "advanced" || outcome === "completed") {
      logger.info("QUIZ", outcome === "completed"
        ? "Answer submitted; quiz completion state detected (correctness not individually exposed)"
        : "Answer submitted; quiz advanced (correctness not exposed)");
      return;
    }
    await saveDiagnostic(page, config.screenshotsDir, logger, "unknown-quiz-result", await quizPanel(page));
    const checked = POST_SUBMIT_CANDIDATE_STATES.join(", ");
    logger.warn("QUIZ", `Post-submit state remained unknown. Checked: ${checked}`);
    throw new AutomationPauseError(
      `Quiz result did not reach a recognized state after ${config.MST_RESULT_TIMEOUT_MS}ms. Checked: ${checked}.`,
    );
  }
}

export async function clickQuizProgressButton(page: Page, logger: Logger): Promise<boolean> {
  const button = page.getByRole("button", { name: /^(next|finish|done|complete|continue)$/i }).filter({ visible: true }).first();
  if (!await button.isVisible().catch(() => false)) return false;
  const label = normalizeText(await button.innerText());
  await button.click();
  logger.info("QUIZ", `Clicked ${label}`);
  return true;
}

export async function isEndOfLessonQuiz(page: Page): Promise<boolean> {
  const marker = page.getByText(/End-lesson Quiz|Answered\s+\d+\s*\/\s*\d+/i).filter({ visible: true }).first();
  return marker.isVisible().catch(() => false);
}

export async function handlePendingResultOverlay(
  page: Page,
  config: AppConfig,
  logger: Logger,
): Promise<"continued" | "retried" | undefined> {
  const continueControl = playerAnnotationLocator(page, "continue");
  if (await continueControl.isVisible().catch(() => false)) {
    await clickPlayerAnnotation(page, "continue", config, logger);
    logger.info("QUIZ", "Recovered an already-correct result and continued the lesson");
    return "continued";
  }
  const retryControl = playerAnnotationLocator(page, "retry");
  if (await retryControl.isVisible().catch(() => false)) {
    await clickPlayerAnnotation(page, "retry", config, logger);
    logger.info("QUIZ", "Recovered a pending retry question");
    return "retried";
  }
  return undefined;
}
