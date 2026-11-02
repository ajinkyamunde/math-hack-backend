export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

export const QUESTION_STATUSES = ['DRAFT', 'ACTIVE'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const COMPETITION_STATUSES = ['DRAFT', 'WAITING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;

export const PROGRESSION_MODES = ['AUTOMATIC', 'MANUAL'] as const;

export const ACADEMIC_YEARS = ['FE', 'SE', 'TE', 'BE', 'PG1', 'PG2'] as const;

export type Role = 'student' | 'host';

export interface AuthUser {
  id: string;
  role: Role;
  sessionId: string;
  /** Session issue time in seconds (JWT iat); used to reject sessions older than a password reset. */
  issuedAt?: number;
}

/** Per-difficulty timing rules, unchanged from the original backend. */
export const DIFFICULTY_RULES: Record<Difficulty, { defaultSeconds: number; minSeconds: number; maxSeconds: number; defaultPoints: number }> = {
  EASY: { defaultSeconds: 25, minSeconds: 20, maxSeconds: 30, defaultPoints: 10 },
  MEDIUM: { defaultSeconds: 300, minSeconds: 300, maxSeconds: 360, defaultPoints: 20 },
  HARD: { defaultSeconds: 900, minSeconds: 720, maxSeconds: 900, defaultPoints: 30 },
};

export const MAX_POINTS = 1000;
export const DEFAULT_COMPETITION_SECONDS = 30 * 60;
export const MIN_COMPETITION_SECONDS = 60;
export const MAX_COMPETITION_SECONDS = 6 * 60 * 60;

/** Answers that arrive this long after a student's timer ran out still count (network delay). */
export const SUBMIT_GRACE_MS = 5000;

export interface CompetitionSettings {
  revealAnswers?: boolean;
  showLeaderboardToStudents?: boolean;
  completeWhenQueueEmpty?: boolean;
  pointsOverride?: Partial<Record<Difficulty, number | null>> | null;
}

/** A frozen copy of a question, taken when the host starts the competition. */
export interface QuestionSnapshot {
  questionText: string;
  options: string[];
  correctOption: OptionKey;
  difficulty: Difficulty;
  timeLimitSeconds: number;
  points: number;
  topic: string;
  explanation: string;
}
