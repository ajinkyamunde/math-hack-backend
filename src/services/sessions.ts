/**
 * Individual exam sessions (rules 4–8): each student clicks Start Test when ready and gets their own timer,
 * answers are final once submitted, and the session ends when the student finishes or the timer runs out.
 */
import { and, eq, lte, sql, sum } from 'drizzle-orm';
import { rowsOf, type Db } from '../db/client.js';
import { answers, competitions, examSessions, participants, type SessionStatus } from '../db/schema.js';
import { SUBMIT_GRACE_MS, type OptionKey } from '../domain.js';
import { AppError, notFound } from '../lib/errors.js';
import type { Realtime } from '../realtime/client.js';
import { assertActiveParticipant, loadCompetition, loadItems, type CompetitionItem, type CompetitionRow } from './competitions.js';

type SessionRow = typeof examSessions.$inferSelect;

/** A session whose timer ran out counts as expired even before the alarm has marked it. */
export function effectiveStatus(session: SessionRow, now = Date.now()): SessionStatus {
  return session.status === 'ACTIVE' && now > session.expiresAt.getTime() ? 'EXPIRED' : session.status;
}

/** Questions as students see them: never the correct option or explanation. */
function publicQuestions(competition: CompetitionRow, items: CompetitionItem[]) {
  return items
    .filter((item) => item.snapshot)
    .map((item) => ({
      id: item.questionId,
      questionText: item.snapshot!.questionText,
      options: item.snapshot!.options,
      difficulty: item.snapshot!.difficulty,
      points: item.snapshot!.points,
      timeLimitSeconds: item.snapshot!.timeLimitSeconds,
      order: item.position,
    }));
}

async function loadSession(db: Db, competitionId: string, studentId: string): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(examSessions)
    .where(and(eq(examSessions.competitionId, competitionId), eq(examSessions.studentId, studentId)))
    .limit(1);
  return session;
}

/** Persists the expiry of one session whose timer has run out (the alarm does the same for everyone). */
async function expireIfDue(db: Db, session: SessionRow, now: Date): Promise<SessionRow> {
  if (effectiveStatus(session, now.getTime()) !== 'EXPIRED' || session.status === 'EXPIRED') return session;
  await db
    .update(examSessions)
    .set({ status: 'EXPIRED', finishedAt: session.expiresAt })
    .where(and(eq(examSessions.competitionId, session.competitionId), eq(examSessions.studentId, session.studentId), eq(examSessions.status, 'ACTIVE')));
  return { ...session, status: 'EXPIRED', finishedAt: session.expiresAt };
}

async function scoreOf(db: Db, competitionId: string, studentId: string): Promise<number> {
  const [row] = await db
    .select({ total: sum(answers.pointsAwarded) })
    .from(answers)
    .where(and(eq(answers.competitionId, competitionId), eq(answers.studentId, studentId)));
  return Number(row?.total ?? 0);
}

async function answerMap(db: Db, competitionId: string, studentId: string) {
  const rows = await db
    .select({ questionId: answers.questionId, selectedOption: answers.selectedOption, submittedAt: answers.submittedAt })
    .from(answers)
    .where(and(eq(answers.competitionId, competitionId), eq(answers.studentId, studentId)));
  return Object.fromEntries(rows.map((row) => [row.questionId, { selectedOption: row.selectedOption, submittedAt: row.submittedAt.toISOString() }]));
}

async function sessionInfo(db: Db, competition: CompetitionRow, session: SessionRow, now: Date) {
  return {
    sessionId: `${session.competitionId}:${session.studentId}`,
    competitionId: session.competitionId,
    studentId: session.studentId,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    durationSeconds: competition.durationSeconds,
    remainingMs: Math.max(0, session.expiresAt.getTime() - now.getTime()),
    serverNow: now.toISOString(),
    status: effectiveStatus(session, now.getTime()),
    score: await scoreOf(db, session.competitionId, session.studentId),
  };
}

/** Rules 4 and 7: Start Test creates the student's own session with its own deadline. Idempotent. */
export async function startTest(db: Db, realtime: Realtime, competitionId: string, studentId: string) {
  await assertActiveParticipant(db, competitionId, studentId);
  const competition = await loadCompetition(db, competitionId);
  const now = new Date();
  let session = await loadSession(db, competitionId, studentId);

  if (!session) {
    if (competition.status !== 'RUNNING') {
      throw new AppError(400, 'COMPETITION_NOT_ACTIVE', competition.status === 'WAITING' || competition.status === 'DRAFT'
        ? 'Competition is not active yet. Please wait for the host to start.'
        : 'This competition has ended.');
    }
    const expiresAt = new Date(now.getTime() + competition.durationSeconds * 1000);
    const created = await db
      .insert(examSessions)
      .values({ competitionId, studentId, startedAt: now, expiresAt, status: 'ACTIVE' })
      .onConflictDoNothing()
      .returning();
    // A double click races two inserts; the loser reads the winner's session.
    session = created[0] ?? (await loadSession(db, competitionId, studentId));
    if (created.length) realtime.sessionsChanged(competitionId);
  }
  if (!session) throw new AppError(500, 'INTERNAL_ERROR', 'Failed to initialize exam session.');

  await db
    .update(participants)
    .set({ lastSeenAt: now })
    .where(and(eq(participants.competitionId, competitionId), eq(participants.studentId, studentId)));

  session = await expireIfDue(db, session, now);
  const items = await loadItems(db, competitionId);
  return {
    session: await sessionInfo(db, competition, session, now),
    questions: publicQuestions(competition, items),
    answers: await answerMap(db, competitionId, studentId),
  };
}

/** Restores the session (and its timer) after a reload. */
export async function mySession(db: Db, competitionId: string, studentId: string) {
  await assertActiveParticipant(db, competitionId, studentId);
  const competition = await loadCompetition(db, competitionId);
  const now = new Date();
  const found = await loadSession(db, competitionId, studentId);
  if (!found) {
    return {
      session: null,
      competitionStatus: competition.status,
      competitionName: competition.name,
      durationSeconds: competition.durationSeconds,
      isRegistered: true,
      serverNow: now.toISOString(),
    };
  }
  const session = await expireIfDue(db, found, now);
  const items = await loadItems(db, competitionId);
  return {
    session: await sessionInfo(db, competition, session, now),
    competitionStatus: competition.status,
    competitionName: competition.name,
    durationSeconds: competition.durationSeconds,
    isRegistered: true,
    serverNow: now.toISOString(),
    questions: publicQuestions(competition, items),
    answers: await answerMap(db, competitionId, studentId),
  };
}

export async function sessionQuestions(db: Db, competitionId: string, studentId: string) {
  await assertActiveParticipant(db, competitionId, studentId);
  const competition = await loadCompetition(db, competitionId);
  if (!(await loadSession(db, competitionId, studentId))) {
    throw new AppError(403, 'NO_ACTIVE_SESSION', 'Questions are only accessible after starting your exam session.');
  }
  return publicQuestions(competition, await loadItems(db, competitionId));
}

/**
 * Rules 6 and 9: records one answer, scored against the frozen snapshot, in a single atomic statement.
 * It only inserts while the session is active, inside its timer (plus a short grace period) and while the
 * competition is running; the primary key makes a second answer to the same question impossible.
 * Response time is measured from the student's previous answer (or from Start Test for the first one).
 */
export async function submitAnswer(
  db: Db,
  realtime: Realtime,
  competitionId: string,
  studentId: string,
  questionId: string,
  selectedOption: OptionKey | null,
) {
  await assertActiveParticipant(db, competitionId, studentId);
  const now = new Date();
  const nowSql = now.toISOString();
  const graceCutoff = new Date(now.getTime() - SUBMIT_GRACE_MS).toISOString();

  const inserted = rowsOf<{ is_correct: boolean; points_awarded: number }>(await db.execute(sql`
    INSERT INTO answers (competition_id, student_id, question_id, difficulty, selected_option, is_correct, points_awarded, response_time_ms, submitted_at)
    SELECT s.competition_id, s.student_id, cq.question_id,
           cq.snapshot->>'difficulty',
           ${selectedOption}::text,
           (${selectedOption}::text IS NOT NULL AND ${selectedOption}::text = cq.snapshot->>'correctOption'),
           CASE WHEN ${selectedOption}::text IS NOT NULL AND ${selectedOption}::text = cq.snapshot->>'correctOption'
                THEN (cq.snapshot->>'points')::int ELSE 0 END,
           GREATEST(0, (EXTRACT(EPOCH FROM (${nowSql}::timestamptz - GREATEST(s.started_at,
             COALESCE((SELECT max(a.submitted_at) FROM answers a WHERE a.competition_id = s.competition_id AND a.student_id = s.student_id), s.started_at)
           ))) * 1000)::int),
           ${nowSql}::timestamptz
    FROM exam_sessions s
    JOIN competitions c ON c.id = s.competition_id
    JOIN competition_questions cq ON cq.competition_id = s.competition_id AND cq.question_id = ${questionId}
    WHERE s.competition_id = ${competitionId}
      AND s.student_id = ${studentId}
      AND s.status = 'ACTIVE'
      AND s.expires_at >= ${graceCutoff}::timestamptz
      AND c.status = 'RUNNING'
      AND cq.snapshot IS NOT NULL
    ON CONFLICT (competition_id, student_id, question_id) DO NOTHING
    RETURNING is_correct, points_awarded`));

  if (!inserted.length) await explainRejectedAnswer(db, competitionId, studentId, questionId, now);

  realtime.answered(competitionId);
  return {
    ok: true,
    questionId,
    selectedOption,
    submittedAt: nowSql,
    score: await scoreOf(db, competitionId, studentId),
  };
}

/** The insert above did nothing; work out why and throw the matching error. */
async function explainRejectedAnswer(db: Db, competitionId: string, studentId: string, questionId: string, now: Date): Promise<never> {
  const session = await loadSession(db, competitionId, studentId);
  if (!session) throw new AppError(403, 'NO_ACTIVE_SESSION', 'Exam session has not been started.');
  const [existing] = await db
    .select({ questionId: answers.questionId })
    .from(answers)
    .where(and(eq(answers.competitionId, competitionId), eq(answers.studentId, studentId), eq(answers.questionId, questionId)))
    .limit(1);
  if (existing) throw new AppError(409, 'ALREADY_SUBMITTED', 'You have already submitted an answer for this question.');
  if (session.status === 'ACTIVE' && now.getTime() > session.expiresAt.getTime() + SUBMIT_GRACE_MS) {
    await expireIfDue(db, session, now);
    throw new AppError(400, 'SESSION_EXPIRED', 'Your exam session has expired.');
  }
  if (session.status !== 'ACTIVE') {
    throw new AppError(400, 'SESSION_NOT_ACTIVE', `Cannot submit answer to a ${session.status.toLowerCase()} session.`);
  }
  const [competition] = await db.select({ status: competitions.status }).from(competitions).where(eq(competitions.id, competitionId)).limit(1);
  if (competition?.status !== 'RUNNING') throw new AppError(400, 'COMPETITION_NOT_ACTIVE', 'This competition is not running.');
  throw notFound('Question not found in this competition.');
}

/** Rule 8: the student finishes early with "Submit & Finish". */
export async function completeTest(db: Db, realtime: Realtime, competitionId: string, studentId: string) {
  await assertActiveParticipant(db, competitionId, studentId);
  const session = await loadSession(db, competitionId, studentId);
  if (!session) throw notFound('Exam session');
  const now = new Date();
  let status = effectiveStatus(session, now.getTime());
  if (status === 'ACTIVE') {
    const [updated] = await db
      .update(examSessions)
      .set({ status: 'COMPLETED', finishedAt: now })
      .where(and(eq(examSessions.competitionId, competitionId), eq(examSessions.studentId, studentId), eq(examSessions.status, 'ACTIVE')))
      .returning({ status: examSessions.status });
    status = updated?.status ?? (await loadSession(db, competitionId, studentId))?.status ?? status;
  } else if (status === 'EXPIRED') {
    await expireIfDue(db, session, now);
  }
  realtime.answered(competitionId);
  return { ok: true, status, score: await scoreOf(db, competitionId, studentId), submittedAt: now.toISOString() };
}

/**
 * Marks every session whose timer has run out as EXPIRED and returns those students, plus the next deadline
 * still pending. Called by the competition's Durable Object alarm.
 */
export async function expireDueSessions(db: Db, competitionId: string, now = new Date()) {
  const expired = await db
    .update(examSessions)
    .set({ status: 'EXPIRED', finishedAt: sql`${examSessions.expiresAt}` })
    .where(and(eq(examSessions.competitionId, competitionId), eq(examSessions.status, 'ACTIVE'), lte(examSessions.expiresAt, now)))
    .returning({ studentId: examSessions.studentId });
  const [next] = await db
    .select({ at: sql<string | null>`min(${examSessions.expiresAt})` })
    .from(examSessions)
    .where(and(eq(examSessions.competitionId, competitionId), eq(examSessions.status, 'ACTIVE')));
  return { expiredStudentIds: expired.map((row) => row.studentId), nextDeadline: next?.at ? new Date(next.at) : null };
}

/** Whether a student's own test is over (finished, expired, or the competition closed). */
export async function studentFinished(db: Db, competition: CompetitionRow, studentId: string): Promise<boolean> {
  if (competition.status === 'COMPLETED' || competition.status === 'CANCELLED') return true;
  const session = await loadSession(db, competition.id, studentId);
  return Boolean(session && effectiveStatus(session) !== 'ACTIVE');
}
