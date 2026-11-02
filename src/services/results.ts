/**
 * Rule 9: results are computed from the stored answers, scored at submission time against the frozen
 * question snapshots. Nothing is cached, so a host view, an export and a student report always agree.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { answers, participants, students } from '../db/schema.js';
import { DIFFICULTIES, type Difficulty } from '../domain.js';
import { toCsv, type CellValue } from '../lib/csv.js';
import { badRequest, notFound } from '../lib/errors.js';
import { buildWorkbook, type SheetSpec } from '../lib/spreadsheet.js';
import { safeFilenamePart } from '../lib/text.js';
import { loadCompetition, loadItems, type CompetitionItem, type CompetitionRow } from './competitions.js';

// ---------------------------------------------------------------------------
// Ranking (unchanged from the original backend)
// ---------------------------------------------------------------------------

/**
 * Deterministic ranking:
 *   1. Total points (higher first)  2. Correct answers (more first)
 *   3. Accuracy = correct / answered (higher first)  4. Average time on correct answers (faster first)
 * Participants equal on all four share a rank (1, 2, 2, 4). Display order inside a tie is by PRN.
 */
export interface RankableEntry {
  prn: string;
  totalPoints: number;
  correct: number;
  accuracy: number | null;
  avgCorrectResponseMs: number | null;
}

function tieKeyCompare(a: RankableEntry, b: RankableEntry): number {
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  if (b.correct !== a.correct) return b.correct - a.correct;
  const accA = a.accuracy ?? -1;
  const accB = b.accuracy ?? -1;
  if (accB !== accA) return accB - accA;
  const timeA = a.avgCorrectResponseMs ?? Number.POSITIVE_INFINITY;
  const timeB = b.avgCorrectResponseMs ?? Number.POSITIVE_INFINITY;
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return 0;
}

export function assignRanks<T extends RankableEntry>(entries: T[]): (T & { rank: number })[] {
  const sorted = entries.slice().sort((a, b) => tieKeyCompare(a, b) || a.prn.localeCompare(b.prn));
  let rank = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || tieKeyCompare(sorted[index - 1]!, entry) !== 0) rank = index + 1;
    return { ...entry, rank };
  });
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry extends RankableEntry {
  rank: number;
  studentId: string;
  name: string;
  department: string;
  incorrect: number;
  answered: number;
}

export async function computeLeaderboard(db: Db, competitionId: string): Promise<LeaderboardEntry[]> {
  const rows = await db
    .select({
      studentId: participants.studentId,
      prn: students.prn,
      name: students.name,
      department: students.department,
      points: sql<number>`coalesce(sum(${answers.pointsAwarded}), 0)::int`,
      correct: sql<number>`count(${answers.questionId}) filter (where ${answers.isCorrect})::int`,
      answered: sql<number>`count(${answers.questionId}) filter (where ${answers.selectedOption} is not null)::int`,
      correctTimeSum: sql<number>`coalesce(sum(${answers.responseTimeMs}) filter (where ${answers.isCorrect}), 0)::bigint`,
    })
    .from(participants)
    .innerJoin(students, eq(students.id, participants.studentId))
    .leftJoin(answers, and(eq(answers.competitionId, participants.competitionId), eq(answers.studentId, participants.studentId)))
    .where(and(eq(participants.competitionId, competitionId), isNull(participants.removedAt)))
    .groupBy(participants.studentId, students.prn, students.name, students.department);

  return assignRanks(
    rows.map((row) => {
      const correct = Number(row.correct);
      const answered = Number(row.answered);
      return {
        studentId: row.studentId,
        prn: row.prn,
        name: row.name,
        department: row.department,
        totalPoints: Number(row.points),
        correct,
        incorrect: answered - correct,
        answered,
        accuracy: answered ? correct / answered : null,
        avgCorrectResponseMs: correct ? Math.round(Number(row.correctTimeSum) / correct) : null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface AttemptRow {
  studentId: string;
  questionId: string;
  difficulty: Difficulty;
  selectedOption: string | null;
  isCorrect: boolean;
  responseTimeMs: number | null;
  pointsAwarded: number;
  submittedAt: Date | null;
  /** Skipped (submitted with no option). Excluded from accuracy and timing, like the old timeouts. */
  timedOut: boolean;
}

export interface DifficultyStats {
  attempted: number;
  correct: number;
  incorrect: number;
  timedOut: number;
  avgResponseMs: number | null;
  avgCorrectResponseMs: number | null;
}

export function difficultyStats(attempts: AttemptRow[]): DifficultyStats {
  const answered = attempts.filter((a) => !a.timedOut);
  const correct = answered.filter((a) => a.isCorrect);
  return {
    attempted: answered.length,
    correct: correct.length,
    incorrect: answered.length - correct.length,
    timedOut: attempts.length - answered.length,
    avgResponseMs: average(answered.map((a) => a.responseTimeMs ?? 0)),
    avgCorrectResponseMs: average(correct.map((a) => a.responseTimeMs ?? 0)),
  };
}

export interface StudentResult extends LeaderboardEntry {
  attempted: number;
  unanswered: number;
  avgResponseMs: number | null;
  byDifficulty: Record<Difficulty, DifficultyStats>;
}

export interface CompetitionAnalytics {
  competition: CompetitionRow;
  items: CompetitionItem[];
  leaderboard: LeaderboardEntry[];
  students: StudentResult[];
  questions: ReturnType<typeof buildQuestionStats>;
  difficulty: ReturnType<typeof buildDifficultySummary>;
  attempts: AttemptRow[];
}

/** Questions every student was given: all of them once the competition has started. */
const servedItems = (c: CompetitionRow, items: CompetitionItem[]) => (c.startedAt ? items.filter((item) => item.snapshot) : []);

async function loadAttempts(db: Db, competitionId: string): Promise<AttemptRow[]> {
  const rows = await db
    .select()
    .from(answers)
    .innerJoin(participants, and(eq(participants.competitionId, answers.competitionId), eq(participants.studentId, answers.studentId)))
    .where(and(eq(answers.competitionId, competitionId), isNull(participants.removedAt)))
    .orderBy(asc(answers.submittedAt));
  return rows.map(({ answers: a }) => ({
    studentId: a.studentId,
    questionId: a.questionId,
    difficulty: a.difficulty,
    selectedOption: a.selectedOption,
    isCorrect: a.isCorrect,
    responseTimeMs: a.responseTimeMs,
    pointsAwarded: a.pointsAwarded,
    submittedAt: a.submittedAt,
    timedOut: a.selectedOption === null,
  }));
}

function buildStudentResults(served: CompetitionItem[], leaderboard: LeaderboardEntry[], attempts: AttemptRow[]): StudentResult[] {
  const byStudent = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const list = byStudent.get(attempt.studentId) ?? [];
    list.push(attempt);
    byStudent.set(attempt.studentId, list);
  }
  return leaderboard.map((entry) => {
    const mine = byStudent.get(entry.studentId) ?? [];
    const answered = mine.filter((a) => !a.timedOut);
    const byDifficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, difficultyStats(mine.filter((a) => a.difficulty === d))])) as Record<Difficulty, DifficultyStats>;
    return {
      ...entry,
      attempted: answered.length,
      unanswered: Math.max(0, served.length - answered.length),
      avgResponseMs: average(answered.map((a) => a.responseTimeMs ?? 0)),
      byDifficulty,
    };
  });
}

function buildQuestionStats(served: CompetitionItem[], attempts: AttemptRow[]) {
  return served.map((item, index) => {
    const mine = attempts.filter((a) => a.questionId === item.questionId);
    const stats = difficultyStats(mine);
    const optionCounts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (const a of mine) if (a.selectedOption) optionCounts[a.selectedOption] = (optionCounts[a.selectedOption] ?? 0) + 1;
    return {
      questionId: item.questionId,
      position: index + 1,
      questionText: item.snapshot!.questionText,
      difficulty: item.snapshot!.difficulty,
      correctOption: item.snapshot!.correctOption,
      submissions: stats.attempted,
      correct: stats.correct,
      incorrect: stats.incorrect,
      timeouts: stats.timedOut,
      accuracy: stats.attempted ? stats.correct / stats.attempted : null,
      avgResponseMs: stats.avgResponseMs,
      optionCounts,
      closeReason: null,
    };
  });
}

function buildDifficultySummary(attempts: AttemptRow[]) {
  return DIFFICULTIES.map((difficulty) => {
    const stats = difficultyStats(attempts.filter((a) => a.difficulty === difficulty));
    return { difficulty, ...stats, accuracy: stats.attempted ? stats.correct / stats.attempted : null };
  });
}

export async function buildCompetitionAnalytics(db: Db, competitionId: string): Promise<CompetitionAnalytics> {
  const competition = await loadCompetition(db, competitionId);
  const [items, leaderboard, attempts] = await Promise.all([loadItems(db, competitionId), computeLeaderboard(db, competitionId), loadAttempts(db, competitionId)]);
  const served = servedItems(competition, items);
  return {
    competition,
    items,
    leaderboard,
    students: buildStudentResults(served, leaderboard, attempts),
    questions: buildQuestionStats(served, attempts),
    difficulty: buildDifficultySummary(attempts),
    attempts,
  };
}

export function summarize(a: CompetitionAnalytics) {
  return {
    competitionId: a.competition.id,
    name: a.competition.name,
    status: a.competition.status,
    participants: a.students.length,
    questionsPublished: servedItems(a.competition, a.items).length,
    totalSubmissions: a.attempts.filter((x) => !x.timedOut).length,
    averageScore: average(a.students.map((s) => s.totalPoints)),
    highestScore: a.students.length ? Math.max(...a.students.map((s) => s.totalPoints)) : null,
  };
}

// ---------------------------------------------------------------------------
// Exports (same columns as the original backend)
// ---------------------------------------------------------------------------

export const CSV_EXPORT_TYPES = ['results', 'students', 'questions', 'difficulty', 'attempts'] as const;
export type CsvExportType = (typeof CSV_EXPORT_TYPES)[number];

const NA = 'N/A';
const seconds = (ms: number | null | undefined): number | string => (ms === null || ms === undefined ? NA : Math.round(ms / 10) / 100);
const percent = (ratio: number | null): number | string => (ratio === null ? NA : Math.round(ratio * 10000) / 100);
const titleCase = (d: Difficulty) => d.charAt(0) + d.slice(1).toLowerCase();

export function exportFilename(a: CompetitionAnalytics, kind: string, extension: 'xlsx' | 'csv', date = new Date()): string {
  return `mathhack-${safeFilenamePart(a.competition.name)}-${a.competition.id.slice(-6)}-${kind}-${date.toISOString().slice(0, 10)}.${extension}`;
}

interface Table {
  headers: string[];
  rows: CellValue[][];
}

function leaderboardTable(a: CompetitionAnalytics): Table {
  return {
    headers: ['Rank', 'PRN', 'Student Name', 'Department', 'Total Score', 'Correct Answers', 'Incorrect Answers', 'Accuracy (%)', 'Average Response Time (s)'],
    rows: a.students.map((s) => [s.rank, s.prn, s.name, s.department, s.totalPoints, s.correct, s.incorrect, percent(s.accuracy), seconds(s.avgResponseMs)]),
  };
}

function studentsTable(a: CompetitionAnalytics): Table {
  return {
    headers: [
      'Rank', 'PRN', 'Student Name', 'Department', 'Total Score', 'Questions Attempted', 'Correct Answers', 'Incorrect Answers',
      'Unanswered Questions', 'Accuracy (%)', 'Avg Easy Response (s)', 'Avg Medium Response (s)', 'Avg Hard Response (s)', 'Avg Correct Response (s)',
    ],
    rows: a.students.map((s) => [
      s.rank, s.prn, s.name, s.department, s.totalPoints, s.attempted, s.correct, s.incorrect, s.unanswered, percent(s.accuracy),
      seconds(s.byDifficulty.EASY.avgResponseMs), seconds(s.byDifficulty.MEDIUM.avgResponseMs), seconds(s.byDifficulty.HARD.avgResponseMs),
      seconds(s.avgCorrectResponseMs),
    ]),
  };
}

const DIFFICULTY_HEADERS = ['PRN', 'Student Name', 'Questions Attempted', 'Correct Answers', 'Incorrect Answers', 'Average Response Time (s)', 'Average Correct Response Time (s)'];

function difficultySheetTable(a: CompetitionAnalytics, difficulty: Difficulty): Table {
  return {
    headers: DIFFICULTY_HEADERS,
    rows: a.students.map((s) => {
      const d = s.byDifficulty[difficulty];
      return [s.prn, s.name, d.attempted, d.correct, d.incorrect, seconds(d.avgResponseMs), seconds(d.avgCorrectResponseMs)];
    }),
  };
}

function difficultyCsvTable(a: CompetitionAnalytics): Table {
  return {
    headers: ['Difficulty', ...DIFFICULTY_HEADERS],
    rows: DIFFICULTIES.flatMap((difficulty) => difficultySheetTable(a, difficulty).rows.map((row) => [difficulty, ...row])),
  };
}

function questionsTable(a: CompetitionAnalytics): Table {
  return {
    headers: ['Question ID', 'Position', 'Question', 'Difficulty', 'Correct Option', 'Submissions', 'Correct Responses', 'Incorrect Responses', 'Skipped Count', 'Accuracy (%)', 'Average Response Time (s)'],
    rows: a.questions.map((q) => [q.questionId, q.position, q.questionText, q.difficulty, q.correctOption, q.submissions, q.correct, q.incorrect, q.timeouts, percent(q.accuracy), seconds(q.avgResponseMs)]),
  };
}

function attemptsTable(a: CompetitionAnalytics): Table {
  const prnById = new Map(a.students.map((s) => [s.studentId, s.prn]));
  return {
    headers: ['PRN', 'Question ID', 'Difficulty', 'Selected Option', 'Correctness', 'Response Time (s)', 'Points Awarded', 'Submission Timestamp'],
    rows: a.attempts
      .filter((attempt) => prnById.has(attempt.studentId))
      .map((attempt) => [
        prnById.get(attempt.studentId),
        attempt.questionId,
        attempt.difficulty,
        attempt.selectedOption ?? 'SKIPPED',
        attempt.timedOut ? 'UNANSWERED' : attempt.isCorrect ? 'CORRECT' : 'INCORRECT',
        seconds(attempt.responseTimeMs),
        attempt.pointsAwarded,
        attempt.submittedAt ? attempt.submittedAt.toISOString() : NA,
      ]),
  };
}

export function parseCsvType(value: unknown): CsvExportType {
  const type = (value ?? 'results') as CsvExportType;
  if (!CSV_EXPORT_TYPES.includes(type)) throw badRequest(`Export type must be one of: ${CSV_EXPORT_TYPES.join(', ')}.`);
  return type;
}

export function csvExport(a: CompetitionAnalytics, type: CsvExportType): string {
  const table = { results: leaderboardTable, students: studentsTable, questions: questionsTable, difficulty: difficultyCsvTable, attempts: attemptsTable }[type](a);
  return toCsv(table.headers, table.rows);
}

/** The six-sheet results workbook. */
export function resultsWorkbook(a: CompetitionAnalytics): Uint8Array<ArrayBuffer> {
  const sheets: SheetSpec[] = [
    { name: 'Leaderboard', ...leaderboardTable(a) },
    ...DIFFICULTIES.map((d) => ({ name: `${titleCase(d)} Analytics`, ...difficultySheetTable(a, d) })),
    { name: 'Question Statistics', ...questionsTable(a) },
    { name: 'All Attempts', ...attemptsTable(a) },
  ];
  return buildWorkbook(sheets);
}

export function studentReportCsv(a: CompetitionAnalytics, studentId: string, hideRank = false): string {
  const s = a.students.find((x) => x.studentId === studentId);
  if (!s) throw notFound('Participant');
  const rows: CellValue[][] = [
    ['Competition', a.competition.name],
    ['PRN', s.prn],
    ['Student Name', s.name],
    ['Department', s.department],
    ...(hideRank ? [] : [['Final Rank', s.rank] as CellValue[]]),
    ['Total Score', s.totalPoints],
    ['Questions Attempted', s.attempted],
    ['Correct Answers', s.correct],
    ['Incorrect Answers', s.incorrect],
    ['Unanswered Questions', s.unanswered],
    ['Accuracy (%)', percent(s.accuracy)],
    ['Average Correct Response (s)', seconds(s.avgCorrectResponseMs)],
  ];
  for (const d of DIFFICULTIES) {
    const stats = s.byDifficulty[d];
    rows.push([`${titleCase(d)}: attempted / correct`, `${stats.attempted} / ${stats.correct}`]);
    rows.push([`${titleCase(d)}: average response (s)`, seconds(stats.avgResponseMs)]);
  }
  const byQuestion = new Map(a.questions.map((q) => [q.questionId, q]));
  for (const attempt of a.attempts.filter((x) => x.studentId === s.studentId)) {
    const q = byQuestion.get(attempt.questionId);
    rows.push([
      `Q${q?.position ?? '?'} (${attempt.difficulty})`,
      attempt.timedOut
        ? 'Skipped'
        : `${attempt.selectedOption} — ${attempt.isCorrect ? 'correct' : 'incorrect'} — ${seconds(attempt.responseTimeMs)} s — ${attempt.pointsAwarded} pts`,
    ]);
  }
  return toCsv(['Field', 'Value'], rows);
}
