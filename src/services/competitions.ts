/**
 * Competition lifecycle, following the game rules:
 *   DRAFT --open--> WAITING (registration open) --start--> RUNNING (Start Test unlocked for everyone)
 *   RUNNING --end--> COMPLETED; any unfinished state --cancel--> CANCELLED.
 * There is no question-by-question host pacing and no pause: once the host starts, each student clicks
 * Start Test when ready and gets their own timer (see sessions.ts).
 */
import { and, count, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { competitionQuestions, competitions, examSessions, participants, questions } from '../db/schema.js';
import { DIFFICULTY_RULES, type CompetitionSettings, type QuestionSnapshot } from '../domain.js';
import { badRequest, forbidden, invalidState, notFound, participantRemoved, AppError } from '../lib/errors.js';
import { iso, isId, newId, questionFingerprint } from '../lib/text.js';
import type { Realtime, RoomMessage } from '../realtime/client.js';
import type { CreateCompetitionInput, DirectQuestionInput, UpdateCompetitionInput } from '../validation/schemas.js';
import { recordAudit } from './audit.js';

export type CompetitionRow = typeof competitions.$inferSelect;

export interface CompetitionItem {
  questionId: string;
  position: number;
  snapshot: QuestionSnapshot | null;
}

// ---------------------------------------------------------------------------
// Loading and access
// ---------------------------------------------------------------------------

export async function loadCompetition(db: Db, id: string): Promise<CompetitionRow> {
  if (!isId(id)) throw notFound('Competition');
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, id)).limit(1);
  if (!competition) throw notFound('Competition');
  return competition;
}

/** Participant names, scores and controls belong to the host who created the competition. */
export async function loadOwnedCompetition(db: Db, id: string, hostId: string): Promise<CompetitionRow> {
  const competition = await loadCompetition(db, id);
  if (competition.createdBy !== hostId) throw forbidden('Only the host who created this competition can manage it.');
  return competition;
}

export async function loadItems(db: Db, competitionId: string): Promise<CompetitionItem[]> {
  return db
    .select({ questionId: competitionQuestions.questionId, position: competitionQuestions.position, snapshot: competitionQuestions.snapshot })
    .from(competitionQuestions)
    .where(eq(competitionQuestions.competitionId, competitionId))
    .orderBy(competitionQuestions.position);
}

/** The participant record, or why the student may not act in this competition. */
export async function assertActiveParticipant(db: Db, competitionId: string, studentId: string): Promise<void> {
  const [row] = await db
    .select({ removedAt: participants.removedAt })
    .from(participants)
    .where(and(eq(participants.competitionId, competitionId), eq(participants.studentId, studentId)))
    .limit(1);
  if (!row) throw new AppError(403, 'NOT_REGISTERED', 'You are not registered for this competition.');
  if (row.removedAt) throw participantRemoved();
}

export async function isRemoved(db: Db, competitionId: string, studentId: string): Promise<boolean> {
  const [row] = await db
    .select({ removedAt: participants.removedAt })
    .from(participants)
    .where(and(eq(participants.competitionId, competitionId), eq(participants.studentId, studentId)))
    .limit(1);
  return Boolean(row?.removedAt);
}

export async function participantCount(db: Db, competitionId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(participants)
    .where(and(eq(participants.competitionId, competitionId), isNull(participants.removedAt)));
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Views (response shapes the frontend already uses)
// ---------------------------------------------------------------------------

const started = (c: CompetitionRow) => Boolean(c.startedAt);
const finished = (c: CompetitionRow) => c.status === 'COMPLETED' || c.status === 'CANCELLED';

function baseState(c: CompetitionRow, totalQuestions: number, now: number) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    durationSeconds: c.durationSeconds,
    questionProgressionMode: c.questionProgressionMode,
    startedAt: iso(c.startedAt),
    // There is no shared end time: every student has their own timer.
    endsAt: null as string | null,
    completedAt: iso(c.completedAt),
    remainingMs: null as number | null,
    serverNow: new Date(now).toISOString(),
    questionNumber: null as number | null,
    totalQuestions,
    currentQuestion: null,
  };
}

export function hostView(c: CompetitionRow, items: CompetitionItem[], now = Date.now()) {
  const queueStatus = finished(c) && started(c) ? 'CLOSED' : started(c) ? 'LIVE' : 'PENDING';
  return {
    ...baseState(c, items.length, now),
    settings: c.settings,
    createdAt: iso(c.createdAt) ?? undefined,
    pausedAt: null,
    completionReason: c.completionReason ?? null,
    queue: items.map((item) => ({
      questionId: item.questionId,
      order: item.position,
      status: queueStatus,
      snapshot: item.snapshot,
      publishedAt: iso(c.startedAt),
      closedAt: queueStatus === 'CLOSED' ? iso(c.completedAt) : null,
      closeReason: queueStatus === 'CLOSED' ? 'COMPETITION_ENDED' : null,
    })),
  };
}

export function studentView(c: CompetitionRow, totalQuestions: number, joined: boolean, now = Date.now()) {
  return {
    ...baseState(c, totalQuestions, now),
    settings: { revealAnswers: false, showLeaderboardToStudents: false },
    joined,
    waitingForHost: c.status === 'WAITING',
    mySubmission: null,
  };
}

/** Pushes the fresh state to everyone watching: the full view to hosts, the sanitized view to students. */
export function stateMessages(c: CompetitionRow, items: CompetitionItem[], extra: RoomMessage[] = []): RoomMessage[] {
  const now = Date.now();
  return [
    ...extra,
    { target: 'hosts', event: 'competition:state', payload: hostView(c, items, now) },
    { target: 'students', event: 'competition:state', payload: studentView(c, items.length, true, now) },
  ];
}

// ---------------------------------------------------------------------------
// Questions of a competition
// ---------------------------------------------------------------------------

/** Saves directly-entered questions to the bank (updating ones that already exist) and returns their IDs in order. */
export async function persistDirectQuestions(db: Db, input: DirectQuestionInput[], hostId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const q of input) {
    const values = {
      questionText: q.questionText,
      options: q.options,
      correctOption: q.correctOption,
      difficulty: q.difficulty,
      timeLimitSeconds: DIFFICULTY_RULES[q.difficulty].defaultSeconds,
      points: q.points ?? DIFFICULTY_RULES[q.difficulty].defaultPoints,
      status: 'ACTIVE' as const,
      fingerprint: await questionFingerprint(q.questionText),
    };
    if (q.id && isId(q.id)) {
      const [updated] = await db
        .update(questions)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(questions.id, q.id))
        .returning({ id: questions.id });
      if (updated) {
        ids.push(updated.id);
        continue;
      }
    }
    const [created] = await db
      .insert(questions)
      .values({ id: newId(), ...values, createdBy: hostId })
      .returning({ id: questions.id });
    ids.push(created!.id);
  }
  return ids;
}

/** Checks a selection of bank questions: all must exist and be ACTIVE. */
async function assertSelectable(db: Db, questionIds: string[]): Promise<void> {
  if (!questionIds.length) return;
  const rows = await db.select({ id: questions.id, status: questions.status }).from(questions).where(inArray(questions.id, questionIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = questionIds.filter((id) => !byId.has(id));
  if (missing.length) throw badRequest(`${missing.length} selected question(s) no longer exist.`, { missing });
  const drafts = rows.filter((row) => row.status !== 'ACTIVE').map((row) => row.id);
  if (drafts.length) throw badRequest('Only ACTIVE questions can be added to a competition. Publish the draft questions first.', { drafts });
}

async function writeQueue(db: Db, competitionId: string, questionIds: string[]): Promise<void> {
  if (questionIds.length) {
    await db
      .insert(competitionQuestions)
      .values(questionIds.map((questionId, position) => ({ competitionId, questionId, position, snapshot: null })))
      .onConflictDoUpdate({
        target: [competitionQuestions.competitionId, competitionQuestions.questionId],
        set: { position: sql`excluded.position`, snapshot: null },
      });
  }
  await db
    .delete(competitionQuestions)
    .where(
      and(
        eq(competitionQuestions.competitionId, competitionId),
        questionIds.length ? notInArray(competitionQuestions.questionId, questionIds) : undefined,
      ),
    );
}

// ---------------------------------------------------------------------------
// Host commands
// ---------------------------------------------------------------------------

export async function createCompetition(db: Db, input: CreateCompetitionInput, hostId: string) {
  const questionIds = input.questions?.length ? await persistDirectQuestions(db, input.questions, hostId) : input.questionIds;
  await assertSelectable(db, questionIds);
  const [created] = await db
    .insert(competitions)
    .values({
      id: newId(),
      name: input.name,
      description: input.description,
      createdBy: hostId,
      durationSeconds: input.durationSeconds,
      questionProgressionMode: input.questionProgressionMode,
      settings: input.settings as CompetitionSettings,
    })
    .returning();
  await writeQueue(db, created!.id, questionIds);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.create', competitionId: created!.id });
  return hostView(created!, await loadItems(db, created!.id));
}

const EDITABLE: CompetitionRow['status'][] = ['DRAFT', 'WAITING'];

export async function updateCompetition(db: Db, realtime: Realtime, id: string, input: UpdateCompetitionInput, hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  if (!EDITABLE.includes(current.status)) throw invalidState('Settings can only be changed before the competition starts.');
  const settings = input.settings ? { ...current.settings, ...Object.fromEntries(Object.entries(input.settings).filter(([, v]) => v !== undefined)) } : current.settings;
  const [updated] = await db
    .update(competitions)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.durationSeconds !== undefined && { durationSeconds: input.durationSeconds }),
      ...(input.questionProgressionMode !== undefined && { questionProgressionMode: input.questionProgressionMode }),
      settings,
      updatedAt: new Date(),
    })
    .where(and(eq(competitions.id, id), inArray(competitions.status, EDITABLE)))
    .returning();
  if (!updated) throw invalidState('Settings can only be changed before the competition starts.');
  const items = await loadItems(db, id);
  realtime.publish(id, stateMessages(updated, items));
  return hostView(updated, items);
}

/** The question list can only change before the start, so every student gets the same test. */
export async function setQueue(db: Db, realtime: Realtime, id: string, questionIds: string[], hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  if (!EDITABLE.includes(current.status)) throw invalidState('Questions can only be added, edited, or removed before the competition starts.');
  await assertSelectable(db, questionIds);
  await writeQueue(db, id, questionIds);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.queue', competitionId: id, details: { count: questionIds.length } });
  const items = await loadItems(db, id);
  realtime.publish(id, stateMessages(current, items));
  return hostView(current, items);
}

export async function setDirectQuestions(db: Db, realtime: Realtime, id: string, input: DirectQuestionInput[], hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  if (!EDITABLE.includes(current.status)) throw invalidState('Questions can only be added, edited, or removed before the competition starts.');
  const questionIds = await persistDirectQuestions(db, input, hostId);
  return setQueue(db, realtime, id, questionIds, hostId);
}

const STATUS_MESSAGES: Record<string, string> = {
  DRAFT: 'the competition is still a draft',
  WAITING: 'the competition has not started yet',
  RUNNING: 'the competition is already running',
  PAUSED: 'the competition is paused',
  COMPLETED: 'the competition has already ended',
  CANCELLED: 'the competition was cancelled',
};
const transitionError = (action: string, from: string) => invalidState(`Cannot ${action}: ${STATUS_MESSAGES[from] ?? `status is ${from}`}.`);

/** Rule 2: the host opens registration. */
export async function openRegistration(db: Db, realtime: Realtime, id: string, hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  const [updated] = await db
    .update(competitions)
    .set({ status: 'WAITING', updatedAt: new Date() })
    .where(and(eq(competitions.id, id), eq(competitions.status, 'DRAFT')))
    .returning();
  if (!updated) throw transitionError('open registration', current.status);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.open', competitionId: id });
  const items = await loadItems(db, id);
  realtime.publish(id, stateMessages(updated, items, [{ target: 'all', event: 'competition:waiting', payload: { competitionId: id } }]));
  return hostView(updated, items);
}

/**
 * Rule 3: the host starts the competition and every Start Test button unlocks. The questions are frozen
 * into snapshots first, so editing the bank afterwards cannot change anyone's test.
 */
export async function startCompetition(db: Db, realtime: Realtime, id: string, hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  if (current.status !== 'WAITING') throw transitionError('start', current.status);
  const items = await loadItems(db, id);
  if (!items.length) throw badRequest('Add at least one question to the queue before starting.');

  const ids = items.map((item) => item.questionId);
  const rows = await db.select().from(questions).where(inArray(questions.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((qid) => !byId.has(qid));
  if (missing.length) throw badRequest(`${missing.length} question(s) in this competition no longer exist.`, { missing });
  const drafts = rows.filter((row) => row.status !== 'ACTIVE').map((row) => row.id);
  if (drafts.length) throw badRequest('Only ACTIVE questions can be used. Publish the draft questions first.', { drafts });

  const override = current.settings?.pointsOverride ?? {};
  const snapshots: Record<string, QuestionSnapshot> = {};
  for (const qid of ids) {
    const q = byId.get(qid)!;
    snapshots[qid] = {
      questionText: q.questionText,
      options: q.options,
      correctOption: q.correctOption,
      difficulty: q.difficulty,
      timeLimitSeconds: q.timeLimitSeconds,
      points: override?.[q.difficulty] ?? q.points,
      topic: q.topic,
      explanation: q.explanation,
    };
  }
  // One statement writes every snapshot.
  await db.execute(sql`
    UPDATE competition_questions AS cq
    SET snapshot = s.value
    FROM jsonb_each(${JSON.stringify(snapshots)}::jsonb) AS s
    WHERE cq.competition_id = ${id} AND cq.question_id = s.key`);

  const now = new Date();
  const [updated] = await db
    .update(competitions)
    .set({ status: 'RUNNING', startedAt: now, endsAt: null, updatedAt: now })
    .where(and(eq(competitions.id, id), eq(competitions.status, 'WAITING')))
    .returning();
  if (!updated) throw transitionError('start', (await loadCompetition(db, id)).status);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.start', competitionId: id });

  const fresh = await loadItems(db, id);
  realtime.publish(
    id,
    stateMessages(updated, fresh, [
      {
        target: 'all',
        event: 'competition:started',
        payload: { competitionId: id, status: 'ACTIVE', startedAt: now.toISOString(), durationSeconds: updated.durationSeconds, serverNow: now.toISOString() },
      },
    ]),
  );
  return hostView(updated, fresh);
}

/** Closes every exam session still running; answers already given keep counting. */
async function closeOpenSessions(db: Db, competitionId: string, now: Date): Promise<void> {
  await db
    .update(examSessions)
    .set({ status: 'COMPLETED', finishedAt: now })
    .where(and(eq(examSessions.competitionId, competitionId), eq(examSessions.status, 'ACTIVE')));
}

/** The host ends the competition: submissions stop for everyone and final results are ready. */
export async function endCompetition(db: Db, realtime: Realtime, id: string, hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  const now = new Date();
  const [updated] = await db
    .update(competitions)
    .set({ status: 'COMPLETED', completedAt: now, completionReason: 'HOST', updatedAt: now })
    .where(and(eq(competitions.id, id), inArray(competitions.status, ['RUNNING', 'PAUSED'])))
    .returning();
  if (!updated) throw transitionError('end', current.status);
  await closeOpenSessions(db, id, now);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.end', competitionId: id });
  const items = await loadItems(db, id);
  realtime.publish(id, stateMessages(updated, items, [{ target: 'all', event: 'competition:completed', payload: { competitionId: id, completedAt: now.toISOString() } }]));
  realtime.answered(id); // final leaderboard to hosts
  return hostView(updated, items);
}

export async function cancelCompetition(db: Db, realtime: Realtime, id: string, hostId: string) {
  const current = await loadOwnedCompetition(db, id, hostId);
  const now = new Date();
  const [updated] = await db
    .update(competitions)
    .set({ status: 'CANCELLED', completedAt: now, completionReason: 'CANCELLED', updatedAt: now })
    .where(and(eq(competitions.id, id), inArray(competitions.status, ['DRAFT', 'WAITING', 'RUNNING', 'PAUSED'])))
    .returning();
  if (!updated) throw transitionError('cancel', current.status);
  await closeOpenSessions(db, id, now);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'competition.cancel', competitionId: id });
  const items = await loadItems(db, id);
  realtime.publish(id, stateMessages(updated, items, [{ target: 'all', event: 'competition:cancelled', payload: { competitionId: id } }]));
  return hostView(updated, items);
}

/** Commands from the old host-paced engine. They do not exist in this game, so they are refused clearly. */
export function unsupportedCommand(command: string): never {
  throw invalidState(`"${command}" is not part of this game: every student answers at their own pace with their own timer once you start the competition.`);
}

// ---------------------------------------------------------------------------
// Queries and joining
// ---------------------------------------------------------------------------

/** Students see every non-draft competition; a host sees the competitions they created. */
export async function listCompetitions(db: Db, role: 'host' | 'student', query: { page: number; pageSize: number; status?: string }, userId: string) {
  const studentId = role === 'student' ? userId : undefined;
  const where =
    role === 'student'
      ? query.status && query.status !== 'DRAFT'
        ? eq(competitions.status, query.status as CompetitionRow['status'])
        : ne(competitions.status, 'DRAFT')
      : and(eq(competitions.createdBy, userId), query.status ? eq(competitions.status, query.status as CompetitionRow['status']) : undefined);
  const questionCount = sql<number>`(SELECT count(*)::int FROM competition_questions cq WHERE cq.competition_id = ${competitions.id})`;
  const participantTotal = sql<number>`(SELECT count(*)::int FROM participants p WHERE p.competition_id = ${competitions.id} AND p.removed_at IS NULL)`;
  const joined = studentId
    ? sql<boolean>`EXISTS (SELECT 1 FROM participants p WHERE p.competition_id = ${competitions.id} AND p.student_id = ${studentId} AND p.removed_at IS NULL)`
    : sql<boolean>`false`;

  const [rows, [total]] = await Promise.all([
    db
      .select({ c: competitions, questionCount, participantTotal, joined })
      .from(competitions)
      .where(where)
      .orderBy(desc(competitions.createdAt), desc(competitions.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(competitions).where(where),
  ]);
  return {
    items: rows.map(({ c, questionCount: qc, participantTotal: pc, joined: j }) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      status: c.status,
      durationSeconds: c.durationSeconds,
      questionCount: Number(qc),
      startedAt: iso(c.startedAt),
      endsAt: null,
      completedAt: iso(c.completedAt),
      createdAt: iso(c.createdAt),
      ...(role === 'student' ? { joined: Boolean(j) } : { participantCount: Number(pc), questionProgressionMode: c.questionProgressionMode }),
    })),
    total: total?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function hostState(db: Db, realtime: Realtime, id: string, hostId: string) {
  const competition = await loadOwnedCompetition(db, id, hostId);
  const [items, total, online] = await Promise.all([loadItems(db, id), participantCount(db, id), realtime.presence(id)]);
  return { ...hostView(competition, items), participants: total, connectedParticipants: online.length };
}

export async function studentState(db: Db, id: string, studentId: string) {
  const competition = await loadCompetition(db, id);
  if (competition.status === 'DRAFT') throw notFound('Competition');
  const [row] = await db
    .select({ removedAt: participants.removedAt })
    .from(participants)
    .where(and(eq(participants.competitionId, id), eq(participants.studentId, studentId)))
    .limit(1);
  if (row?.removedAt) throw participantRemoved();
  const [total] = await db.select({ value: count() }).from(competitionQuestions).where(eq(competitionQuestions.competitionId, id));
  return studentView(competition, total?.value ?? 0, Boolean(row));
}

/** Rule 1: a student joins (registers for) a competition while it is open or running. */
export async function joinCompetition(db: Db, realtime: Realtime, id: string, studentId: string) {
  const competition = await loadCompetition(db, id);
  if (await isRemoved(db, id, studentId)) throw participantRemoved();
  if (!['WAITING', 'RUNNING', 'PAUSED'].includes(competition.status)) {
    throw invalidState(competition.status === 'DRAFT' ? 'This competition is not open yet.' : 'This competition is no longer accepting participants.');
  }
  const inserted = await db.insert(participants).values({ competitionId: id, studentId }).onConflictDoNothing().returning({ id: participants.studentId });
  if (inserted.length) {
    realtime.publish(id, [{ target: 'hosts', event: 'participant:joined', payload: { competitionId: id, participantCount: await participantCount(db, id) } }]);
  }
  return studentState(db, id, studentId);
}

export async function publicStatus(db: Db, id: string) {
  const competition = await loadCompetition(db, id);
  return {
    competitionId: id,
    name: competition.name,
    status: competition.status === 'RUNNING' ? 'ACTIVE' : competition.status,
    registrationStatus: competition.status === 'WAITING' ? 'OPEN' : competition.status === 'DRAFT' ? 'NOT_OPEN' : 'CLOSED',
    startedAt: iso(competition.startedAt),
    durationSeconds: competition.durationSeconds,
    serverNow: new Date().toISOString(),
  };
}
