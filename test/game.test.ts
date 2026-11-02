/**
 * End-to-end checks of the nine MathHack rules, plus the compatibility promises made to existing data
 * (Argon2id hashes and sessions from the Node backend).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { createHostAccount } from '../src/services/accounts.js';
import { verifyPassword } from '../src/auth/password.js';
import { expireDueSessions } from '../src/services/sessions.js';
import { newId } from '../src/lib/text.js';
import { createHarness, SECRET } from './harness.js';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;

const HOST = { name: 'Test Host', email: 'host@mathhack.test', password: 'HostPassw0rd!' };
const QUESTIONS = [
  { questionText: 'What is 2 + 2?', options: ['3', '4', '5', '6'], correctOption: 'B', difficulty: 'EASY' },
  { questionText: 'What is 12 x 12?', options: ['124', '144', '154', '164'], correctOption: 'B', difficulty: 'MEDIUM' },
  { questionText: 'Derivative of x^3?', options: ['x^2', '3x^2', '3x', 'x^3/3'], correctOption: 'B', difficulty: 'HARD' },
];

function student(n: number) {
  return {
    name: `Student ${n}`,
    prn: `PRN00${n}00`,
    email: `student${n}@mathhack.test`,
    department: 'Computer',
    academicYear: 'SE',
    password: 'Student#Pass1',
    confirmPassword: 'Student#Pass1',
  };
}

beforeAll(async () => {
  h = await createHarness();
  await createHostAccount(h.db, HOST);
});

describe('existing data keeps working', () => {
  it('verifies an Argon2id hash produced by a different implementation (the old backend’s format)', async () => {
    const legacy = '$argon2id$v=19$m=19456,t=2,p=1$o2GRWtLdizJ88qqDQAhpkg$0sAWzcFZQHWauAf6s1TOKT6+tRh2fl0u/Pw3SWGqih0';
    expect(await verifyPassword(legacy, 'LegacyPass#2026')).toBe(true);
    expect(await verifyPassword(legacy, 'wrong-password')).toBe(false);
  });

  it('accepts a session cookie signed by jsonwebtoken, as the old backend issued them', async () => {
    const id = newId();
    await h.db.execute(sql`INSERT INTO hosts (id, name, email, password_hash) VALUES (${id}, 'Old Host', 'old@mathhack.test', 'x')`);
    const token = jwt.sign({ role: 'host', sid: 'legacy-session' }, SECRET, { subject: id, expiresIn: '12h', algorithm: 'HS256', issuer: 'mathhack' });
    const c = h.client();
    c.setCookie(`mh_session=${token}`);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.user).toMatchObject({ _id: id, role: 'host' });
  });
});

describe('a full game, following the rules', () => {
  const host = () => hostClient;
  let hostClient: ReturnType<Harness['client']>;
  let s1: ReturnType<Harness['client']>;
  let s2: ReturnType<Harness['client']>;
  let s3: ReturnType<Harness['client']>;
  let competitionId = '';
  let questionIds: string[] = [];
  const ids: Record<string, string> = {};

  it('host signs in and creates a competition with direct questions', async () => {
    hostClient = h.client();
    const login = await host().post('/api/auth/login', { role: 'host', email: HOST.email, password: HOST.password });
    expect(login.status).toBe(200);

    const created = await host().post('/api/competitions', {
      name: 'Rules Cup',
      durationSeconds: 600,
      questionProgressionMode: 'AUTOMATIC',
      settings: {},
      questions: QUESTIONS,
    });
    expect(created.status).toBe(201);
    competitionId = created.data.competition.id;
    expect(created.data.competition.status).toBe('DRAFT');
    expect(created.data.competition.queue).toHaveLength(3);
    questionIds = created.data.competition.queue.map((q: { questionId: string }) => q.questionId);
  });

  it('host can edit the questions before the start (the old routing bug sent this to a 404)', async () => {
    const saved = await host().put(`/api/competitions/${competitionId}/questions`, { questions: QUESTIONS.map((q, i) => ({ ...q, id: questionIds[i] })) });
    expect(saved.status).toBe(200);
    expect(saved.data.competition.queue.map((q: { questionId: string }) => q.questionId)).toEqual(questionIds);
  });

  it('rule 1: students register; joining waits until the host opens registration', async () => {
    s1 = h.client();
    s2 = h.client();
    s3 = h.client();
    for (const [n, c] of [[1, s1], [2, s2], [3, s3]] as const) {
      const reg = await c.post('/api/auth/register', student(n));
      expect(reg.status).toBe(201);
      ids[`s${n}`] = reg.data.user._id;
    }
    const early = await s1.post(`/api/competitions/${competitionId}/join`);
    expect(early.status).toBe(409);
    expect(early.data.error.message).toBe('This competition is not open yet.');
  });

  it('rule 2: the host opens registration and students join', async () => {
    const opened = await host().post(`/api/competitions/${competitionId}/open`);
    expect(opened.status).toBe(200);
    expect(opened.data.competition.status).toBe('WAITING');
    for (const c of [s1, s2, s3]) {
      const joined = await c.post(`/api/competitions/${competitionId}/join`);
      expect(joined.status).toBe(200);
      expect(joined.data.competition).toMatchObject({ joined: true, status: 'WAITING', waitingForHost: true });
    }
    const joinedEvents = h.events.filter((e) => e.message.event === 'participant:joined');
    expect(joinedEvents.at(-1)?.message.payload).toMatchObject({ participantCount: 3 });
  });

  it('rule 3: Start Test stays locked until the host starts, then unlocks for everyone', async () => {
    const early = await s1.post(`/api/competitions/${competitionId}/start-test`);
    expect(early.status).toBe(400);
    expect(early.data.error.code).toBe('COMPETITION_NOT_ACTIVE');

    const started = await host().post(`/api/competitions/${competitionId}/start`);
    expect(started.status).toBe(200);
    expect(started.data.competition.status).toBe('RUNNING');
    expect(started.data.competition.queue.every((q: { snapshot: unknown }) => q.snapshot)).toBe(true);

    const unlock = h.events.find((e) => e.message.event === 'competition:started');
    expect(unlock?.message).toMatchObject({ target: 'all', payload: { status: 'ACTIVE', durationSeconds: 600 } });
    const status = await s2.get(`/api/competitions/${competitionId}/status`);
    expect(status.data.status).toBe('ACTIVE');
  });

  it('rules 4 and 7: each student starts when ready and gets their own timer', async () => {
    const first = await s1.post(`/api/competitions/${competitionId}/start-test`);
    expect(first.status).toBe(200);
    expect(first.data.session.status).toBe('ACTIVE');
    expect(first.data.session.remainingMs).toBeGreaterThan(599_000);
    expect(h.signals.sessionsChanged).toBe(1);

    // Rule 5: the three difficulties, and never the answer.
    expect(first.data.questions.map((q: { difficulty: string }) => q.difficulty)).toEqual(['EASY', 'MEDIUM', 'HARD']);
    expect(JSON.stringify(first.data.questions)).not.toContain('correctOption');

    // Clicking again returns the same session (no second timer).
    const again = await s1.post(`/api/competitions/${competitionId}/start-test`);
    expect(again.data.session.expiresAt).toBe(first.data.session.expiresAt);
    expect(h.signals.sessionsChanged).toBe(1);

    // Student 2 starts "three minutes later": their deadline is their own.
    await new Promise((r) => setTimeout(r, 20));
    const second = await s2.post(`/api/competitions/${competitionId}/start-test`);
    expect(new Date(second.data.session.expiresAt).getTime()).toBeGreaterThan(new Date(first.data.session.expiresAt).getTime());
  });

  it('rule 6: an answer is scored once and cannot be changed', async () => {
    const correct = await s1.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[0], selectedOption: 'B' });
    expect(correct.status).toBe(200);
    expect(correct.data.score).toBe(10);

    const change = await s1.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[0], selectedOption: 'A' });
    expect(change.status).toBe(409);
    expect(change.data.error.code).toBe('ALREADY_SUBMITTED');

    const wrong = await s1.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[1], selectedOption: 'A' });
    expect(wrong.data.score).toBe(10);

    // Two submissions racing for the same question: exactly one is recorded.
    const race = await Promise.all([
      s2.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[2], selectedOption: 'B' }),
      s2.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[2], selectedOption: 'B' }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);

    const restored = await s1.get(`/api/competitions/${competitionId}/my-session`);
    expect(Object.keys(restored.data.answers)).toHaveLength(2);
    expect(restored.data.session.score).toBe(10);

    // Someone who never pressed Start Test cannot answer.
    const noSession = await s3.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[0], selectedOption: 'B' });
    expect(noSession.data.error.code).toBe('NO_ACTIVE_SESSION');
  });

  it('rule 8: when a timer runs out the session ends, even with the tab closed', async () => {
    // Move student 1's deadline into the past, as if their 10 minutes were up.
    await h.db.execute(sql`UPDATE exam_sessions SET expires_at = now() - interval '1 minute' WHERE student_id = ${ids.s1}`);
    const late = await s1.post(`/api/competitions/${competitionId}/submit`, { questionId: questionIds[2], selectedOption: 'B' });
    expect(late.status).toBe(400);
    expect(late.data.error.code).toBe('SESSION_EXPIRED');

    // What the Durable Object alarm runs at the deadline:
    await h.db.execute(sql`UPDATE exam_sessions SET status = 'ACTIVE' WHERE student_id = ${ids.s1}`);
    const { expiredStudentIds, nextDeadline } = await expireDueSessions(h.db, competitionId);
    expect(expiredStudentIds).toEqual([ids.s1]);
    expect(nextDeadline).toBeInstanceOf(Date); // student 2 is still running
  });

  it('rule 9: results are ready for a student as soon as their own test is over', async () => {
    const mine = await s1.get(`/api/competitions/${competitionId}/results`);
    expect(mine.status).toBe(200);
    expect(mine.data.me).toEqual({ prn: 'PRN00100', attempted: 2, correct: 1, incorrect: 1, unanswered: 1 });

    // Student 2 is still playing.
    const notYet = await s2.get(`/api/competitions/${competitionId}/results`);
    expect(notYet.status).toBe(409);

    // Student 2 finishes early with "Submit & Finish".
    const done = await s2.post(`/api/competitions/${competitionId}/complete`);
    expect(done.data).toMatchObject({ ok: true, status: 'COMPLETED', score: 30 });
    expect((await s2.get(`/api/competitions/${competitionId}/results`)).data.me).toMatchObject({ correct: 1, unanswered: 2 });

    // Students never see rankings.
    expect((await s1.get(`/api/competitions/${competitionId}/leaderboard`)).data.entries).toEqual([]);
  });

  it('host sees the leaderboard, participant statuses and analytics', async () => {
    const board = await host().get(`/api/competitions/${competitionId}/leaderboard`);
    expect(board.data.entries.map((e: { name: string; totalPoints: number; rank: number }) => [e.name, e.totalPoints, e.rank])).toEqual([
      ['Student 2', 30, 1],
      ['Student 1', 10, 2],
      ['Student 3', 0, 3],
    ]);

    h.online.set(competitionId, new Set([ids.s3!]));
    const view = await host().get(`/api/competitions/${competitionId}/participants`);
    const statusOf = (name: string) => view.data.rows.find((r: { name: string }) => r.name === name).status;
    expect(statusOf('Student 1')).toBe('COMPLETED');
    expect(statusOf('Student 2')).toBe('COMPLETED');
    expect(statusOf('Student 3')).toBe('PLAYING');

    const analytics = await host().get(`/api/competitions/${competitionId}/analytics`);
    expect(analytics.data.summary).toMatchObject({ participants: 3, questionsPublished: 3, totalSubmissions: 3, highestScore: 30 });
    expect(analytics.data.questions[0]).toMatchObject({ submissions: 1, correct: 1 });

    const state = await host().get(`/api/competitions/${competitionId}`);
    expect(state.data.competition).toMatchObject({ participants: 3, connectedParticipants: 1 });
  });

  it('host-paced commands from the old engine are refused clearly', async () => {
    const paused = await host().post(`/api/competitions/${competitionId}/pause`);
    expect(paused.status).toBe(409);
    expect(paused.data.error.message).toContain('own timer');
  });

  it('exports open as real spreadsheets', async () => {
    const xlsx = await host().raw('GET', `/api/competitions/${competitionId}/export.xlsx`);
    expect(xlsx.status).toBe(200);
    const book = XLSX.read(new Uint8Array(await xlsx.res.arrayBuffer()), { type: 'array' });
    expect(book.SheetNames).toEqual(['Leaderboard', 'Easy Analytics', 'Medium Analytics', 'Hard Analytics', 'Question Statistics', 'All Attempts']);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets.Leaderboard!);
    expect(rows[0]).toMatchObject({ Rank: 1, 'Student Name': 'Student 2', 'Total Score': 30 });

    const csv = await host().raw('GET', `/api/competitions/${competitionId}/export.csv?type=attempts`);
    expect(csv.status).toBe(200);
    expect(await csv.res.text()).toContain('PRN00100');

    const people = await host().raw('GET', `/api/competitions/${competitionId}/participants/export.xlsx?tz=Asia/Kolkata`);
    expect(people.status).toBe(200);
  });

  it('the host ends the competition: everyone still playing stops, results are final', async () => {
    const ended = await host().post(`/api/competitions/${competitionId}/end`);
    expect(ended.data.competition.status).toBe('COMPLETED');
    expect(h.events.some((e) => e.message.event === 'competition:completed')).toBe(true);
    const late = await s3.post(`/api/competitions/${competitionId}/start-test`);
    expect(late.data.error.code).toBe('COMPETITION_NOT_ACTIVE');
    expect((await s3.get(`/api/competitions/${competitionId}/results`)).data.me).toMatchObject({ attempted: 0, unanswered: 3 });
  });

  it('removing a participant can be undone within the window', async () => {
    const removed = await host().del(`/api/competitions/${competitionId}/participants/${ids.s3}`);
    expect(removed.data).toEqual({ ok: true, deleted: true });
    expect(h.signals.kicked).toContain(ids.s3);
    expect((await s3.get(`/api/competitions/${competitionId}/state`)).data.error.code).toBe('PARTICIPANT_REMOVED');

    const undone = await host().post(`/api/competitions/${competitionId}/participants/undo-delete`, { studentIds: [ids.s3] });
    expect(undone.data).toEqual({ ok: true, restoredCount: 1 });
    expect((await s3.get(`/api/competitions/${competitionId}/state`)).status).toBe(200);
  });
});

describe('security and bank management', () => {
  it('rejects writes from other origins and without the CSRF token', async () => {
    const c = h.client();
    await c.post('/api/auth/login', { role: 'host', email: HOST.email, password: HOST.password });
    const foreign = await h.app.request(
      '/api/competitions',
      { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' },
      h.env,
    );
    expect(foreign.status).toBe(403);
  });

  it('locks a student account after five wrong passwords', async () => {
    const c = h.client();
    for (let i = 0; i < 5; i += 1) await c.post('/api/auth/login', { role: 'student', identifier: 'PRN00100', password: 'nope' });
    const locked = await c.post('/api/auth/login', { role: 'student', identifier: 'PRN00100', password: 'Student#Pass1' });
    expect(locked.status).toBe(429);
  });

  it('imports the downloadable xlsx template and flags duplicates', async () => {
    const c = h.client();
    await c.post('/api/auth/login', { role: 'host', email: HOST.email, password: HOST.password });
    const template = await c.raw('GET', '/api/questions/template.xlsx');
    const file = new File([await template.res.arrayBuffer()], 'questions.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const preview = await c.upload('/api/questions/import/preview', file);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ fileType: 'xlsx', totalRows: 2, validCount: 2, invalidCount: 0 });

    const confirm = await c.post('/api/questions/import/confirm', { batchId: preview.data.batchId });
    expect(confirm.data).toMatchObject({ insertedCount: 2 });

    const csvFile = new File([await (await c.raw('GET', '/api/questions/template.csv')).res.arrayBuffer()], 'q.csv', { type: 'text/csv' });
    const again = await c.upload('/api/questions/import/preview', csvFile);
    expect(again.data).toMatchObject({ fileType: 'csv', validCount: 0, duplicateCount: 2 });

    const list = await c.get('/api/questions?search=25%25&pageSize=5');
    expect(list.data.total).toBe(1);
  });
});

describe('competition lists', () => {
  it('a host lists their own competitions; students see every open one', async () => {
    const host = h.client();
    await host.post('/api/auth/login', { role: 'host', email: HOST.email, password: HOST.password });
    const mine = await host.get('/api/competitions');
    expect(mine.data.items.map((c: { name: string }) => c.name)).toEqual(['Rules Cup']);
    expect(mine.data.items[0]).toMatchObject({ questionCount: 3, participantCount: 3 });

    const student = h.client();
    await student.post('/api/auth/login', { role: 'student', identifier: 'PRN00200', password: 'Student#Pass1' });
    const visible = await student.get('/api/competitions');
    expect(visible.data.items[0]).toMatchObject({ name: 'Rules Cup', joined: true, status: 'COMPLETED' });
  });
});
