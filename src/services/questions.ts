import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { competitionQuestions, competitions, questions, type CompetitionStatus } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { escapeLike, iso, newId, questionFingerprint } from '../lib/text.js';
import type { QuestionInput, QuestionListQuery } from '../validation/schemas.js';

type QuestionRow = typeof questions.$inferSelect;

/** Host view of a question (includes the answer). Matches the original JSON shape. */
export function questionJson(q: QuestionRow) {
  return {
    _id: q.id,
    questionText: q.questionText,
    options: q.options,
    correctOption: q.correctOption,
    difficulty: q.difficulty,
    timeLimitSeconds: q.timeLimitSeconds,
    points: q.points,
    topic: q.topic,
    explanation: q.explanation,
    tags: q.tags,
    status: q.status,
    createdBy: q.createdBy,
    importBatchId: q.importBatchId ?? undefined,
    importedAt: q.importedAt ? iso(q.importedAt) : undefined,
    createdAt: iso(q.createdAt),
    updatedAt: iso(q.updatedAt),
  };
}

export async function listQuestions(db: Db, query: QuestionListQuery) {
  const filters: SQL[] = [];
  if (query.difficulty) filters.push(eq(questions.difficulty, query.difficulty));
  if (query.status) filters.push(eq(questions.status, query.status));
  if (query.topic) filters.push(sql`lower(${questions.topic}) = lower(${query.topic})`);
  if (query.search) {
    const pattern = `%${escapeLike(query.search)}%`;
    filters.push(
      or(
        ilike(questions.questionText, pattern),
        ilike(questions.topic, pattern),
        sql`EXISTS (SELECT 1 FROM unnest(${questions.tags}) AS tag WHERE tag ILIKE ${pattern})`,
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const order =
    query.sort === 'oldest'
      ? [asc(questions.createdAt), asc(questions.id)]
      : query.sort === 'difficulty'
        ? [sql`CASE ${questions.difficulty} WHEN 'EASY' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'HARD' THEN 3 ELSE 9 END`, desc(questions.createdAt), asc(questions.id)]
        : [desc(questions.createdAt), desc(questions.id)];

  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(questions)
      .where(where)
      .orderBy(...order)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(questions).where(where),
  ]);
  return { items: items.map(questionJson), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

export async function listTopics(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ topic: questions.topic }).from(questions);
  return rows
    .map((row) => row.topic)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function getQuestion(db: Db, id: string) {
  const [question] = await db.select().from(questions).where(eq(questions.id, id)).limit(1);
  if (!question) throw notFound('Question');
  return questionJson(question);
}

export async function createQuestion(db: Db, input: QuestionInput, hostId: string) {
  const [created] = await db
    .insert(questions)
    .values({ id: newId(), ...input, fingerprint: await questionFingerprint(input.questionText), createdBy: hostId })
    .returning();
  return questionJson(created!);
}

/** The first competition (by status) that uses this question, if any. */
async function competitionUsing(db: Db, questionId: string, statuses: CompetitionStatus[]) {
  const [row] = await db
    .select({ name: competitions.name })
    .from(competitionQuestions)
    .innerJoin(competitions, eq(competitions.id, competitionQuestions.competitionId))
    .where(and(eq(competitionQuestions.questionId, questionId), inArray(competitions.status, statuses)))
    .limit(1);
  return row;
}

/** Questions in a live competition are locked; the test plays frozen snapshots, but edits are refused to avoid confusion. */
async function assertNotLocked(db: Db, id: string, action: 'edit' | 'delete'): Promise<void> {
  const live = await competitionUsing(db, id, ['RUNNING', 'PAUSED']);
  if (live) throw conflict(`This question is in the live competition "${live.name}" and cannot be ${action === 'edit' ? 'edited' : 'deleted'} until it ends.`);
}

export async function updateQuestion(db: Db, id: string, input: QuestionInput) {
  await assertNotLocked(db, id, 'edit');
  const [updated] = await db
    .update(questions)
    .set({ ...input, fingerprint: await questionFingerprint(input.questionText), updatedAt: new Date() })
    .where(eq(questions.id, id))
    .returning();
  if (!updated) throw notFound('Question');
  return questionJson(updated);
}

export async function deleteQuestion(db: Db, id: string): Promise<void> {
  await assertNotLocked(db, id, 'delete');
  const queued = await competitionUsing(db, id, ['DRAFT', 'WAITING']);
  if (queued) throw conflict(`Remove this question from the queue of "${queued.name}" before deleting it.`);
  const deleted = await db.delete(questions).where(eq(questions.id, id)).returning({ id: questions.id });
  if (!deleted.length) throw notFound('Question');
}

export async function duplicateQuestion(db: Db, id: string, hostId: string) {
  const [source] = await db.select().from(questions).where(eq(questions.id, id)).limit(1);
  if (!source) throw notFound('Question');
  const text = `${source.questionText} (copy)`.slice(0, 2000);
  const [copy] = await db
    .insert(questions)
    .values({
      id: newId(),
      questionText: text,
      options: source.options,
      correctOption: source.correctOption,
      difficulty: source.difficulty,
      timeLimitSeconds: source.timeLimitSeconds,
      points: source.points,
      topic: source.topic,
      explanation: source.explanation,
      tags: source.tags,
      status: 'DRAFT',
      fingerprint: await questionFingerprint(text),
      createdBy: hostId,
    })
    .returning();
  return questionJson(copy!);
}
