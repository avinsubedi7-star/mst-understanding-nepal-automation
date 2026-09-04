export interface CombinationStatement {
  label: string;
  text: string;
}

export interface CombinationQuestionContext {
  referencedLabels: string[];
  statements: CombinationStatement[];
  requiresVisual: boolean;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  visual: boolean;
  completeText: boolean;
  optionTargetCount?: number;
  combination?: CombinationQuestionContext;
}

export interface AnswerDecision {
  answerIndex: number;
  answerLabel: string;
  answerText: string;
  confidence: number;
  reason: string;
  source: "provider" | "cache" | "human";
}

export interface VideoState {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
}

export type QuizOutcome = "correct" | "incorrect" | "advanced" | "completed" | "unknown";
