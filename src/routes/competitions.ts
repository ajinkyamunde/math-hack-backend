import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../context.js';
import { authOf } from '../context.js';
import { jsonBody, requireAuth, requireHost, requireStudent } from '../auth/middleware.js';
import { participants } from '../db/schema.js';
import { AppError, invalidState, notFound, parse, participantRemoved } from '../lib/errors.js';
import { XLSX_CONTENT_TYPE } from '../lib/spreadsheet.js';
import { recordAudit } from '../services/audit.js';
import * as competitions from '../services/competitions.js';
import * as people from '../services/participants.js';
import * as results from '../services/results.js';
import * as sessions from '../services/sessions.js';
import {
  competitionListQuerySchema,
  createCompetitionSchema,
  deleteBulkParticipantsSchema,
  idParams,
  participantParams,
  participantQuerySchema,
  resetParticipantPasswordSchema,
  setDirectQuestionsSchema,
  setQueueSchema,
  submitAnswerSchema,
  undoDeleteParticipantsSchema,
  updateCompetitionSchema,
} from '../validation/schemas.js';

export const competitionRoutes = new Hono<AppEnv>();
competitionRoutes.use('*', requireAuth);

const idOf = (c: { req: { param(): Record<string, string> } }) => parse(idParams, c.req.param()).id;
const ctx = (c: Parameters<typeof authOf>[0]) => ({ db: c.get('db'), realtime: c.get('realtime'), user: authOf(c) });

const download = (contentType: string, filename: string) => ({
  'content-type': contentType,
  'content-disposition': `attachment; filename="${filename}"`,
  'cache-control': 'no-store',
});

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

competitionRoutes.get('/', async (c) => {
  const { db, user } = ctx(c);
  const query = parse(competitionListQuerySchema, c.req.query());
  return c.json(await competitions.listCompetitions(db, user.role, query, user.id));
});

competitionRoutes.post('/', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const input = parse(createCompetitionSchema, await jsonBody(c));
  return c.json({ competition: await competitions.createCompetition(db, input, user.id) }, 201);
});

/** Hosts get the full control view; students get the sanitized state. */
const getState = async (c: Parameters<typeof authOf>[0]) => {
  const { db, realtime, user } = ctx(c);
  const id = idOf(c);
  const competition = user.role === 'host' ? await competitions.hostState(db, realtime, id, user.id) : await competitions.studentState(db, id, user.id);
  return c.json({ competition });
};
competitionRoutes.get('/:id', getState);
competitionRoutes.get('/:id/state', getState);

competitionRoutes.patch('/:id', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const input = parse(updateCompetitionSchema, await jsonBody(c));
  return c.json({ competition: await competitions.updateCompetition(db, realtime, idOf(c), input, user.id) });
});

competitionRoutes.put('/:id/queue', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const { questionIds } = parse(setQueueSchema, await jsonBody(c));
  return c.json({ competition: await competitions.setQueue(db, realtime, idOf(c), questionIds, user.id) });
});

competitionRoutes.put('/:id/questions', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const { questions } = parse(setDirectQuestionsSchema, await jsonBody(c));
  return c.json({ competition: await competitions.setDirectQuestions(db, realtime, idOf(c), questions, user.id) });
});

competitionRoutes.get('/:id/status', async (c) => c.json(await competitions.publicStatus(c.get('db'), idOf(c))));

// Host commands. pause/resume/publish/release-all/skip belonged to the old host-paced engine.
const COMMANDS = {
  open: competitions.openRegistration,
  'open-registration': competitions.openRegistration,
  start: competitions.startCompetition,
  end: competitions.endCompetition,
  cancel: competitions.cancelCompetition,
} as const;
for (const [name, action] of Object.entries(COMMANDS)) {
  competitionRoutes.post(`/:id/${name}`, requireHost, async (c) => {
    const { db, realtime, user } = ctx(c);
    const competition = await action(db, realtime, idOf(c), user.id);
    // The host start route used to answer with these top-level fields as well; keep them for older clients.
    return c.json({ ...competition, competition, ok: true });
  });
}
for (const name of ['pause', 'resume', 'publish', 'release-all', 'skip']) {
  competitionRoutes.post(`/:id/${name}`, requireHost, () => competitions.unsupportedCommand(name));
}

// ---------------------------------------------------------------------------
// Live events (Server-Sent Events via the competition's Durable Object)
// ---------------------------------------------------------------------------

competitionRoutes.get('/:id/events', async (c) => {
  const { db, realtime, user } = ctx(c);
  const id = idOf(c);
  const competition = await competitions.loadCompetition(db, id);
  if (user.role === 'host') {
    if (competition.createdBy !== user.id) throw new AppError(403, 'FORBIDDEN', 'Only the host who created this competition can watch it.');
  } else {
    const [row] = await db
      .update(participants)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(participants.competitionId, id), eq(participants.studentId, user.id)))
      .returning({ removedAt: participants.removedAt });
    if (row?.removedAt) throw participantRemoved();
  }
  const hello = {
    competitionId: id,
    status: competition.status === 'RUNNING' ? 'ACTIVE' : competition.status,
    serverNow: new Date().toISOString(),
    role: user.role,
  };
  const stream = await realtime.connect(id, user, hello, c.req.raw);
  // Responses from a Durable Object have immutable headers; copy so the security/CORS middleware can add theirs.
  return new Response(stream.body, stream);
});

// ---------------------------------------------------------------------------
// Students: join, Start Test, answer, finish
// ---------------------------------------------------------------------------

competitionRoutes.post('/:id/join', requireStudent, async (c) => {
  const { db, realtime, user } = ctx(c);
  return c.json({ competition: await competitions.joinCompetition(db, realtime, idOf(c), user.id) });
});

competitionRoutes.post('/:id/start-test', requireStudent, async (c) => {
  const { db, realtime, user } = ctx(c);
  return c.json(await sessions.startTest(db, realtime, idOf(c), user.id));
});

competitionRoutes.get('/:id/my-session', requireStudent, async (c) => {
  const { db, user } = ctx(c);
  return c.json(await sessions.mySession(db, idOf(c), user.id));
});

competitionRoutes.get('/:id/questions', requireStudent, async (c) => {
  const { db, user } = ctx(c);
  return c.json({ questions: await sessions.sessionQuestions(db, idOf(c), user.id) });
});

competitionRoutes.post('/:id/submit', requireStudent, async (c) => {
  const { db, realtime, user } = ctx(c);
  const body = parse(submitAnswerSchema, await jsonBody(c));
  return c.json(await sessions.submitAnswer(db, realtime, idOf(c), user.id, body.questionId, body.selectedOption ?? null));
});

/** Older answer endpoint: same rules, original response shape (a repeat is 200 with alreadySubmitted). */
competitionRoutes.post('/:id/answers', requireStudent, async (c) => {
  const { db, realtime, user } = ctx(c);
  const body = parse(submitAnswerSchema, await jsonBody(c));
  try {
    const result = await sessions.submitAnswer(db, realtime, idOf(c), user.id, body.questionId, body.selectedOption ?? null);
    return c.json({ submission: { questionId: result.questionId, selectedOption: result.selectedOption, submittedAt: result.submittedAt, alreadySubmitted: false } }, 201);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ALREADY_SUBMITTED') {
      return c.json({ submission: { questionId: body.questionId, selectedOption: body.selectedOption ?? null, submittedAt: null, alreadySubmitted: true } });
    }
    throw error;
  }
});

competitionRoutes.post('/:id/complete', requireStudent, async (c) => {
  const { db, realtime, user } = ctx(c);
  return c.json(await sessions.completeTest(db, realtime, idOf(c), user.id));
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Students never see rankings or other students' scores. */
competitionRoutes.get('/:id/leaderboard', async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  if (user.role === 'host') {
    await competitions.loadOwnedCompetition(db, id, user.id);
    const entries = await results.computeLeaderboard(db, id);
    return c.json({ entries, total: entries.length });
  }
  await competitions.assertActiveParticipant(db, id, user.id);
  return c.json({ entries: [], total: 0, me: null });
});

/** Hosts see everyone; a student sees their own four numbers once their own test is over (rule 9). */
competitionRoutes.get('/:id/results', async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  if (user.role === 'host') {
    await competitions.loadOwnedCompetition(db, id, user.id);
    const analytics = await results.buildCompetitionAnalytics(db, id);
    return c.json({ summary: results.summarize(analytics), students: analytics.students });
  }
  await competitions.assertActiveParticipant(db, id, user.id);
  const competition = await competitions.loadCompetition(db, id);
  if (!(await sessions.studentFinished(db, competition, user.id))) throw invalidState('Your results are available once you finish the test.');
  const analytics = await results.buildCompetitionAnalytics(db, id);
  const me = analytics.students.find((s) => s.studentId === user.id);
  if (!me) throw notFound('Your result');
  return c.json({
    summary: { name: analytics.competition.name },
    me: { prn: me.prn, attempted: me.attempted, correct: me.correct, incorrect: me.incorrect, unanswered: me.unanswered },
  });
});

competitionRoutes.get('/:id/analytics', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  await competitions.loadOwnedCompetition(db, id, user.id);
  const data = await results.buildCompetitionAnalytics(db, id);
  return c.json({ summary: results.summarize(data), questions: data.questions, difficulty: data.difficulty });
});

competitionRoutes.get('/:id/export.xlsx', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  await competitions.loadOwnedCompetition(db, id, user.id);
  const data = await results.buildCompetitionAnalytics(db, id);
  await recordAudit(db, { actorId: user.id, actorRole: 'host', action: 'results.export', competitionId: id, details: { format: 'xlsx' } });
  return c.body(results.resultsWorkbook(data), 200, download(XLSX_CONTENT_TYPE, results.exportFilename(data, 'results', 'xlsx')));
});

competitionRoutes.get('/:id/export.csv', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  await competitions.loadOwnedCompetition(db, id, user.id);
  const type = results.parseCsvType(c.req.query('type'));
  const data = await results.buildCompetitionAnalytics(db, id);
  await recordAudit(db, { actorId: user.id, actorRole: 'host', action: 'results.export', competitionId: id, details: { format: 'csv', type } });
  return c.body(results.csvExport(data, type), 200, download('text/csv; charset=utf-8', results.exportFilename(data, type, 'csv')));
});

competitionRoutes.get('/:id/my-report.csv', requireStudent, async (c) => {
  const { db, user } = ctx(c);
  const id = idOf(c);
  await competitions.assertActiveParticipant(db, id, user.id);
  const competition = await competitions.loadCompetition(db, id);
  if (!(await sessions.studentFinished(db, competition, user.id))) throw invalidState('Your report is available once you finish the test.');
  const data = await results.buildCompetitionAnalytics(db, id);
  const prn = data.students.find((s) => s.studentId === user.id)?.prn ?? 'student';
  return c.body(results.studentReportCsv(data, user.id, true), 200, download('text/csv; charset=utf-8', results.exportFilename(data, `report-${prn}`, 'csv')));
});

competitionRoutes.get('/:id/students/:studentId/report.csv', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const { id, studentId } = parse(participantParams, c.req.param());
  await competitions.loadOwnedCompetition(db, id, user.id);
  const data = await results.buildCompetitionAnalytics(db, id);
  const prn = data.students.find((s) => s.studentId === studentId)?.prn ?? 'student';
  return c.body(results.studentReportCsv(data, studentId), 200, download('text/csv; charset=utf-8', results.exportFilename(data, `report-${prn}`, 'csv')));
});

// ---------------------------------------------------------------------------
// Host participant dashboard and management
// ---------------------------------------------------------------------------

competitionRoutes.get('/:id/participants', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const query = parse(participantQuerySchema, c.req.query());
  c.header('cache-control', 'no-store');
  return c.json(await people.buildParticipantView(db, realtime, idOf(c), user.id, query));
});

competitionRoutes.get('/:id/participants/export.xlsx', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const id = idOf(c);
  const query = parse(participantQuerySchema, c.req.query());
  const [view, email] = await Promise.all([people.buildParticipantView(db, realtime, id, user.id, query), people.hostEmail(db, user.id)]);
  await recordAudit(db, { actorId: user.id, actorRole: 'host', action: 'participants.export', competitionId: id, details: { format: 'xlsx', rows: view.rows.length } });
  return c.body(people.participantWorkbook(view, query, email), 200, download(XLSX_CONTENT_TYPE, people.participantExportFilename(view)));
});

competitionRoutes.post('/:id/participants/:studentId/password', requireHost, async (c) => {
  const { db, user } = ctx(c);
  const { id, studentId } = parse(participantParams, c.req.param());
  const { password } = parse(resetParticipantPasswordSchema, await jsonBody(c));
  await people.resetParticipantPassword(db, id, studentId, password, user.id);
  return c.json({ reset: true });
});

competitionRoutes.delete('/:id/participants/:studentId', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const { id, studentId } = parse(participantParams, c.req.param());
  const result = await people.removeParticipants(db, realtime, id, [studentId], user.id);
  return c.json({ ok: true, deleted: result.deletedCount > 0 });
});

competitionRoutes.post('/:id/participants/delete-bulk', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const { studentIds } = parse(deleteBulkParticipantsSchema, await jsonBody(c));
  return c.json({ ok: true, ...(await people.removeParticipants(db, realtime, idOf(c), studentIds, user.id)) });
});

competitionRoutes.post('/:id/participants/delete-all', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  return c.json({ ok: true, ...(await people.removeAllParticipants(db, realtime, idOf(c), user.id)) });
});

competitionRoutes.post('/:id/participants/undo-delete', requireHost, async (c) => {
  const { db, realtime, user } = ctx(c);
  const { studentIds } = parse(undoDeleteParticipantsSchema, await jsonBody(c));
  return c.json({ ok: true, ...(await people.undoRemoveParticipants(db, realtime, idOf(c), user.id, studentIds)) });
});
