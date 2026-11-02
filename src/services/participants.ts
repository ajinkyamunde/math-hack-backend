/** The host's participant dashboard, its Excel export, and participant management. */
import { and, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { competitions, examSessions, hosts, participants, rosterEntries, students } from '../db/schema.js';
import type { Config } from '../env.js';
import { badRequest, forbidden, invalidState, isUniqueViolation, notFound } from '../lib/errors.js';
import { buildWorkbook, inTimeZone } from '../lib/spreadsheet.js';
import type { CellValue } from '../lib/csv.js';
import { iso, normalizeEmail, safeFilenamePart } from '../lib/text.js';
import type { Realtime } from '../realtime/client.js';
import {
  PARTICIPANT_STATUSES,
  type CreateParticipantInput,
  type ParticipantQuery,
  type ParticipantStatus,
} from '../validation/schemas.js';
import { createStudentAccount, setStudentPassword, studentJson } from './accounts.js';
import { recordAudit } from './audit.js';
import { loadItems, loadOwnedCompetition, participantCount, type CompetitionRow } from './competitions.js';
import { computeLeaderboard } from './results.js';
import { effectiveStatus } from './sessions.js';

const LIVE_STATUSES = ['WAITING', 'RUNNING', 'PAUSED'];
/** How long a host can undo a removal. */
const UNDO_WINDOW_MS = 15_000;

/**
 * Maps the game state onto a participant status. A student whose own test is over is COMPLETED even while
 * others are still playing (individual timers).
 */
export function participantStatus(
  competition: CompetitionRow,
  participant: { lastSeenAt: Date | null } | null,
  online: boolean,
  sessionDone: boolean,
): ParticipantStatus {
  if (!participant) return 'REGISTERED';
  if (competition.status === 'COMPLETED' || sessionDone) return 'COMPLETED';
  if (competition.status === 'CANCELLED') return 'CANCELLED';
  const wasConnected = Boolean(participant.lastSeenAt);
  if (competition.status === 'RUNNING' || competition.status === 'PAUSED') {
    if (online) return 'PLAYING';
    return wasConnected ? 'DISCONNECTED' : 'JOINED';
  }
  if (!online && wasConnected) return 'DISCONNECTED';
  return 'JOINED';
}

export interface ParticipantRow {
  studentId: string;
  name: string;
  email: string;
  prn: string;
  department: string;
  academicYear: string;
  status: ParticipantStatus;
  online: boolean;
  registeredAt: string | null;
  joinedAt: string | null;
  lastSeenAt: string | null;
  rank: number | null;
  totalPoints: number | null;
  correct: number | null;
  answered: number | null;
  accuracy: number | null;
  avgCorrectResponseMs: number | null;
  completedAt: string | null;
}

function matches(row: ParticipantRow, query: ParticipantQuery): boolean {
  if (query.status && row.status !== query.status) return false;
  if (query.academicYear && row.academicYear !== query.academicYear) return false;
  if (query.department && row.department.toLowerCase() !== query.department.toLowerCase()) return false;
  if (query.search) {
    const haystack = [row.name, row.email, row.prn, row.department].join(' ').toLowerCase();
    if (!haystack.includes(query.search.toLowerCase())) return false;
  }
  return true;
}

export async function buildParticipantView(db: Db, realtime: Realtime, competitionId: string, hostId: string, query: ParticipantQuery) {
  const competition = await loadOwnedCompetition(db, competitionId, hostId);
  const includeRegistered = query.includeRegistered || query.status === 'REGISTERED';

  const [joinedRows, leaderboard, online, sessions, items] = await Promise.all([
    db
      .select({ p: participants, s: students })
      .from(participants)
      .innerJoin(students, eq(students.id, participants.studentId))
      .where(and(eq(participants.competitionId, competitionId), isNull(participants.removedAt))),
    computeLeaderboard(db, competitionId),
    LIVE_STATUSES.includes(competition.status) ? realtime.presence(competitionId) : Promise.resolve([] as string[]),
    db.select().from(examSessions).where(eq(examSessions.competitionId, competitionId)),
    loadItems(db, competitionId),
  ]);
  const scoreById = new Map(leaderboard.map((entry) => [entry.studentId, entry]));
  const sessionById = new Map(sessions.map((session) => [session.studentId, session]));
  const onlineSet = new Set(online);
  const rows: ParticipantRow[] = [];

  for (const { p, s } of joinedRows) {
    const isOnline = onlineSet.has(s.id);
    const score = scoreById.get(s.id);
    const session = sessionById.get(s.id);
    const sessionDone = Boolean(session && effectiveStatus(session) !== 'ACTIVE');
    const status = participantStatus(competition, p, isOnline, sessionDone);
    rows.push({
      studentId: s.id,
      name: s.name,
      email: s.email,
      prn: s.prn,
      department: s.department,
      academicYear: s.academicYear,
      status,
      online: isOnline,
      registeredAt: iso(s.createdAt),
      joinedAt: iso(p.joinedAt),
      lastSeenAt: iso(p.lastSeenAt),
      rank: score?.rank ?? null,
      totalPoints: score?.totalPoints ?? null,
      correct: score?.correct ?? null,
      answered: score?.answered ?? null,
      accuracy: score?.accuracy ?? null,
      avgCorrectResponseMs: score?.avgCorrectResponseMs ?? null,
      completedAt: status === 'COMPLETED' ? iso(session?.finishedAt ?? (sessionDone ? session?.expiresAt : null) ?? competition.completedAt) : null,
    });
  }

  if (includeRegistered) {
    const joined = new Set(joinedRows.map(({ s }) => s.id));
    const everyone = await db.select().from(students);
    for (const s of everyone) {
      if (joined.has(s.id)) continue;
      rows.push({
        studentId: s.id,
        name: s.name,
        email: s.email,
        prn: s.prn,
        department: s.department,
        academicYear: s.academicYear,
        status: 'REGISTERED',
        online: false,
        registeredAt: iso(s.createdAt),
        joinedAt: null,
        lastSeenAt: null,
        rank: null,
        totalPoints: null,
        correct: null,
        answered: null,
        accuracy: null,
        avgCorrectResponseMs: null,
        completedAt: null,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    return a.name.localeCompare(b.name) || a.prn.localeCompare(b.prn);
  });

  const counts = Object.fromEntries(PARTICIPANT_STATUSES.map((s) => [s, 0])) as Record<ParticipantStatus, number> & { total: number };
  for (const row of rows) counts[row.status] += 1;
  counts.total = rows.length;

  return {
    competition: {
      id: competition.id,
      name: competition.name,
      status: competition.status,
      durationSeconds: competition.durationSeconds,
      questionCount: items.length,
      startedAt: iso(competition.startedAt),
      endsAt: null,
      completedAt: iso(competition.completedAt),
    },
    rows: rows.filter((row) => matches(row, query)),
    counts,
    departments: [...new Set(rows.map((row) => row.department))].sort((a, b) => a.localeCompare(b)),
    generatedAt: new Date().toISOString(),
  };
}

export type ParticipantView = Awaited<ReturnType<typeof buildParticipantView>>;

const EXPORT_HEADERS = [
  'Name', 'Email', 'PRN', 'Department', 'Year of Study', 'Status', 'Connected Now', 'Joined At', 'Rank', 'Score',
  'Correct Answers', 'Questions Answered', 'Accuracy (%)', 'Avg Correct Response (s)', 'Completed At', 'Competition', 'Competition Status',
];

function describeFilters(query: ParticipantQuery): string {
  const parts = [
    query.search && `search "${query.search}"`,
    query.status && `status ${query.status}`,
    query.department && `department ${query.department}`,
    query.academicYear && `year ${query.academicYear}`,
    query.includeRegistered && 'including registered students who have not joined',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : 'None (all joined participants)';
}

const toDate = (value: string | null) => (value ? new Date(value) : null);

export function participantWorkbook(view: ParticipantView, query: ParticipantQuery, exportedBy: string): Uint8Array<ArrayBuffer> {
  const timeZone = query.tz ?? 'UTC';
  const rows: CellValue[][] = view.rows.map((row) => [
    row.name,
    row.email,
    row.prn,
    row.department,
    row.academicYear,
    row.status,
    row.online ? 'Yes' : 'No',
    inTimeZone(toDate(row.joinedAt), timeZone),
    row.rank,
    row.totalPoints,
    row.correct,
    row.answered,
    row.accuracy === null ? null : Math.round(row.accuracy * 10000) / 100,
    row.avgCorrectResponseMs === null ? null : Math.round(row.avgCorrectResponseMs / 10) / 100,
    inTimeZone(toDate(row.completedAt), timeZone),
    view.competition.name,
    view.competition.status,
  ]);
  const c = view.competition;
  return buildWorkbook([
    {
      name: 'Participants',
      headers: EXPORT_HEADERS,
      rows,
      widths: EXPORT_HEADERS.map((h) => (h === 'Email' ? 32 : h === 'Name' || h === 'Competition' ? 26 : Math.max(12, h.length + 4))),
      autoFilter: true,
    },
    {
      name: 'Competition',
      headers: ['Field', 'Value'],
      widths: [26, 48],
      rows: [
        ['Competition', c.name],
        ['Competition ID', c.id],
        ['Status', c.status],
        ['Questions', c.questionCount],
        ['Time per student (minutes)', Math.round(c.durationSeconds / 6) / 10],
        ['Started At', inTimeZone(toDate(c.startedAt), timeZone)],
        ['Completed At', inTimeZone(toDate(c.completedAt), timeZone)],
        ['Participants in this export', view.rows.length],
        ['Filters applied', describeFilters(query)],
        ['Exported At', inTimeZone(new Date(view.generatedAt), timeZone)],
        ['Time zone of all times', timeZone],
        ['Exported By', exportedBy],
        ['Note', 'Snapshot only. Editing this file does not change MathHack records.'],
      ],
    },
  ]);
}

export function participantExportFilename(view: { competition: { id: string; name: string } }, date = new Date()): string {
  return `mathhack-${safeFilenamePart(view.competition.name)}-${view.competition.id.slice(-6)}-participants-${date.toISOString().slice(0, 10)}.xlsx`;
}

export async function hostEmail(db: Db, hostId: string): Promise<string> {
  const [host] = await db.select({ email: hosts.email }).from(hosts).where(eq(hosts.id, hostId)).limit(1);
  return host?.email ?? 'host';
}

// ---------------------------------------------------------------------------
// Adding participants and resetting passwords
// ---------------------------------------------------------------------------

export const ASSIGNABLE_STATUSES = ['DRAFT', 'WAITING', 'RUNNING', 'PAUSED'] as const;

export async function assignableCompetitions(db: Db, hostId: string) {
  const rows = await db
    .select({ id: competitions.id, name: competitions.name, status: competitions.status })
    .from(competitions)
    .where(and(eq(competitions.createdBy, hostId), inArray(competitions.status, [...ASSIGNABLE_STATUSES])))
    .orderBy(desc(competitions.createdAt));
  return rows;
}

function assertAllowedEmailDomain(config: Config, email: string): void {
  if (!config.allowedEmailDomains.length) return;
  const domain = normalizeEmail(email).split('@')[1] ?? '';
  if (!config.allowedEmailDomains.includes(domain)) {
    const message = `Use an email address from ${config.allowedEmailDomains.map((d) => `@${d}`).join(' or ')}.`;
    throw badRequest(message, [{ field: 'email', message }]);
  }
}

const PRN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function generatePrn(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const prn = `MH${[...bytes].map((b) => PRN_ALPHABET[b % PRN_ALPHABET.length]).join('')}`;
    const taken = await db.select({ id: students.id }).from(students).where(eq(students.prn, prn)).limit(1);
    if (!taken.length) return prn;
  }
  throw new Error('Could not generate a unique PRN');
}

/** A host creates a student account for someone (4-character password) and optionally adds them to a competition. */
export async function createParticipant(db: Db, config: Config, realtime: Realtime, input: CreateParticipantInput, hostId: string) {
  assertAllowedEmailDomain(config, input.email);
  let competition: CompetitionRow | null = null;
  if (input.competitionId) {
    const [found] = await db.select().from(competitions).where(eq(competitions.id, input.competitionId)).limit(1);
    if (!found) throw notFound('Competition');
    if (found.createdBy !== hostId) throw forbidden('You can only add participants to competitions you created.');
    if (!(ASSIGNABLE_STATUSES as readonly string[]).includes(found.status)) throw invalidState('This competition has ended, so participants can no longer be added to it.');
    competition = found;
  }

  const generatedPrn = !input.prn;
  const prn = input.prn ?? (await generatePrn(db));
  const email = normalizeEmail(input.email);
  const [roster] = config.rosterEnforced ? await db.select().from(rosterEntries).where(eq(rosterEntries.prn, prn)).limit(1) : [];

  const student = await createStudentAccount(
    db,
    { name: input.name, prn, email, department: input.department, academicYear: input.academicYear, rosterVerified: Boolean(roster && roster.email === email) },
    input.password,
  );

  if (competition) {
    try {
      await db
        .insert(participants)
        .values({ competitionId: competition.id, studentId: student.id })
        .onConflictDoUpdate({ target: [participants.competitionId, participants.studentId], set: { removedAt: null, removedBy: null } });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        await db.delete(students).where(eq(students.id, student.id)).catch(() => undefined);
        throw error;
      }
    }
    realtime.publish(competition.id, [
      { target: 'hosts', event: 'participant:joined', payload: { competitionId: competition.id, participantCount: await participantCount(db, competition.id) } },
    ]);
  }

  await recordAudit(db, {
    actorId: hostId,
    actorRole: 'host',
    action: 'participant.create',
    competitionId: competition?.id,
    details: { studentId: student.id, generatedPrn },
  });
  return { participant: { ...studentJson(student), role: 'student' }, competition: competition ? { id: competition.id, name: competition.name } : null, generatedPrn };
}

export async function resetParticipantPassword(db: Db, competitionId: string, studentId: string, password: string, hostId: string) {
  await loadOwnedCompetition(db, competitionId, hostId);
  const [row] = await db
    .select({ id: participants.studentId })
    .from(participants)
    .where(and(eq(participants.competitionId, competitionId), eq(participants.studentId, studentId)))
    .limit(1);
  if (!row || !(await setStudentPassword(db, studentId, password))) throw notFound('Participant');
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'participant.password_reset', competitionId, details: { studentId } });
}

// ---------------------------------------------------------------------------
// Removing participants (soft delete with a short undo window)
// ---------------------------------------------------------------------------

/**
 * Marks participants as removed. Their answers stay in the database but drop out of every result; the student
 * is disconnected and blocked from rejoining. Undo within the window simply clears the mark.
 */
export async function removeParticipants(db: Db, realtime: Realtime, competitionId: string, studentIds: string[], hostId: string) {
  await loadOwnedCompetition(db, competitionId, hostId);
  if (!studentIds.length) return { deletedCount: 0 };
  const removed = await db
    .update(participants)
    .set({ removedAt: new Date(), removedBy: hostId })
    .where(and(eq(participants.competitionId, competitionId), inArray(participants.studentId, studentIds), isNull(participants.removedAt)))
    .returning({ studentId: participants.studentId });
  if (!removed.length) return { deletedCount: 0 };

  const ids = removed.map((row) => row.studentId);
  realtime.kick(competitionId, ids);
  realtime.publish(competitionId, [
    { target: 'hosts', event: 'participant:joined', payload: { competitionId, participantCount: await participantCount(db, competitionId) } },
  ]);
  realtime.answered(competitionId);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'participant.delete', competitionId, details: { count: ids.length, studentIds: ids } });
  return { deletedCount: ids.length };
}

export async function removeAllParticipants(db: Db, realtime: Realtime, competitionId: string, hostId: string) {
  await loadOwnedCompetition(db, competitionId, hostId);
  const rows = await db
    .select({ studentId: participants.studentId })
    .from(participants)
    .where(and(eq(participants.competitionId, competitionId), isNull(participants.removedAt)));
  return removeParticipants(db, realtime, competitionId, rows.map((row) => row.studentId), hostId);
}

export async function undoRemoveParticipants(db: Db, realtime: Realtime, competitionId: string, hostId: string, studentIds?: string[]) {
  await loadOwnedCompetition(db, competitionId, hostId);
  const restored = await db
    .update(participants)
    .set({ removedAt: null, removedBy: null })
    .where(
      and(
        eq(participants.competitionId, competitionId),
        eq(participants.removedBy, hostId),
        isNotNull(participants.removedAt),
        gte(participants.removedAt, new Date(Date.now() - UNDO_WINDOW_MS)),
        studentIds?.length ? inArray(participants.studentId, studentIds) : undefined,
      ),
    )
    .returning({ studentId: participants.studentId });
  if (!restored.length) throw badRequest('No recently deleted participants found to undo (undo window may have expired).');

  const ids = restored.map((row) => row.studentId);
  realtime.publish(competitionId, [
    { target: 'hosts', event: 'participant:joined', payload: { competitionId, participantCount: await participantCount(db, competitionId) } },
    ...ids.map((studentId) => ({ target: 'student' as const, studentId, event: 'participant:restored', payload: { competitionId } })),
  ]);
  realtime.answered(competitionId);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'participant.undo_delete', competitionId, details: { count: ids.length, studentIds: ids } });
  return { restoredCount: ids.length };
}
