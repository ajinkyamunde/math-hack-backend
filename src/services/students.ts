import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { rowsOf, type Db } from '../db/client.js';
import { competitions, examSessions, participants, questions, rosterEntries, students } from '../db/schema.js';
import { parseCsv } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';
import { escapeLike, iso, normalizeEmail, normalizePrn } from '../lib/text.js';
import type { Realtime } from '../realtime/client.js';
import { studentJson } from './accounts.js';
import { hostView, loadItems, participantCount } from './competitions.js';

export async function listStudents(db: Db, query: { page: number; pageSize: number; search?: string }) {
  const where = query.search
    ? or(
        ilike(students.name, `%${escapeLike(query.search)}%`),
        ilike(students.prn, `%${escapeLike(query.search)}%`),
        ilike(students.email, `%${escapeLike(query.search)}%`),
        ilike(students.department, `%${escapeLike(query.search)}%`),
      )
    : undefined;
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(students)
      .where(where)
      .orderBy(desc(students.createdAt), desc(students.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(students).where(where),
  ]);
  return { items: items.map(studentJson), total: total?.value ?? 0, page: query.page, pageSize: query.pageSize };
}

/** A student's competitions, newest first, with their score so far. */
export async function studentHistory(db: Db, studentId: string, query: { page: number; pageSize: number }) {
  const where = and(eq(participants.studentId, studentId), isNull(participants.removedAt));
  const score = sql<number>`(SELECT coalesce(sum(a.points_awarded), 0)::int FROM answers a WHERE a.competition_id = ${participants.competitionId} AND a.student_id = ${participants.studentId})`;
  const [rows, [total]] = await Promise.all([
    db
      .select({ p: participants, c: competitions, s: examSessions, score })
      .from(participants)
      .innerJoin(competitions, eq(competitions.id, participants.competitionId))
      .leftJoin(examSessions, and(eq(examSessions.competitionId, participants.competitionId), eq(examSessions.studentId, participants.studentId)))
      .where(where)
      .orderBy(desc(participants.joinedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(participants).where(where),
  ]);
  return {
    items: rows.map(({ p, c, s, score: points }) => ({
      competitionId: c.id,
      name: c.name,
      status: c.status,
      joinedAt: iso(p.joinedAt),
      completedAt: iso(s?.finishedAt ?? c.completedAt),
      finalScore: s ? Number(points) : null,
      finalRank: null,
    })),
    total: total?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

const MAX_ROSTER_ROWS = 20000;

/** Replaces the official roster from a CSV with PRN and Email columns (Name optional). */
export async function importRoster(db: Db, file: File, hostId: string) {
  let records: string[][];
  try {
    records = parseCsv(await file.text(), MAX_ROSTER_ROWS + 1);
  } catch (error) {
    throw badRequest(`The roster CSV could not be read: ${(error as Error).message}`);
  }
  const [header = [], ...body] = records;
  const columns = header.map((h) => h.trim().toLowerCase());
  const col = (name: string) => columns.indexOf(name);
  const errors: { row: number; message: string }[] = [];
  const entries = new Map<string, { prn: string; email: string; name: string }>();
  body.forEach((record, index) => {
    const prn = normalizePrn(record[col('prn')] ?? '');
    const email = normalizeEmail(record[col('email')] ?? '');
    if (!/^[A-Z0-9]{6,20}$/.test(prn) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push({ row: index + 2, message: 'PRN (6–20 letters/digits) and a valid email are required.' });
      return;
    }
    entries.set(prn, { prn, email, name: (record[col('name')] ?? '').trim().slice(0, 100) });
  });
  if (!entries.size) throw badRequest('No valid roster rows found. The CSV needs PRN and Email columns.', errors.slice(0, 50));

  const docs = [...entries.values()].map((entry) => ({ ...entry, uploadedBy: hostId }));
  await db.delete(rosterEntries);
  for (let i = 0; i < docs.length; i += 1000) await db.insert(rosterEntries).values(docs.slice(i, i + 1000));
  await db.update(students).set({ rosterVerified: false });
  const verified = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE students s SET roster_verified = true
    FROM roster_entries r
    WHERE r.prn = s.prn AND r.email = s.email
    RETURNING s.id`));
  return { imported: docs.length, invalid: errors.length, errors: errors.slice(0, 50), matchedStudents: verified.length };
}

export async function rosterSize(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(rosterEntries);
  return row?.value ?? 0;
}

/** Counts for the host dashboard cards. */
export async function hostOverview(db: Db, realtime: Realtime, hostId: string) {
  const [[registered], [active], [total], [live]] = await Promise.all([
    db.select({ value: count() }).from(students),
    db.select({ value: count() }).from(questions).where(eq(questions.status, 'ACTIVE')),
    db.select({ value: count() }).from(questions),
    db
      .select()
      .from(competitions)
      .where(and(eq(competitions.createdBy, hostId), inArray(competitions.status, ['RUNNING', 'PAUSED', 'WAITING'])))
      .orderBy(sql`CASE ${competitions.status} WHEN 'RUNNING' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END`, desc(competitions.updatedAt))
      .limit(1),
  ]);

  let activeCompetition = null;
  if (live) {
    const [items, participantsTotal, online, [answersReceived]] = await Promise.all([
      loadItems(db, live.id),
      participantCount(db, live.id),
      realtime.presence(live.id),
      db.execute(sql`SELECT count(*)::int AS value FROM answers WHERE competition_id = ${live.id}`).then((r) => rowsOf<{ value: number }>(r)),
    ]);
    activeCompetition = {
      ...hostView(live, items),
      participants: participantsTotal,
      connectedParticipants: online.length,
      answersReceived: Number(answersReceived?.value ?? 0),
    };
  }

  return {
    registeredStudents: registered?.value ?? 0,
    activeQuestions: active?.value ?? 0,
    totalQuestions: total?.value ?? 0,
    activeCompetition,
  };
}
