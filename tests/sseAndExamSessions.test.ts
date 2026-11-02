import request from 'supertest';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.js';
import { createHostAccount } from '../src/services/authService.js';
import { HOST, ORIGIN, questionPayload, studentPayload } from './helpers.js';

let server: RunningServer;
let base: string;

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

interface Session {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: string;
  cookie: string;
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
}

function wrap(agent: ReturnType<typeof request.agent>, csrf: string, user: { id?: string; _id?: string }, cookie: string): Session {
  const withHeaders = (test: request.Test) => test.set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
  return {
    agent,
    csrf,
    id: user.id || user._id || '',
    cookie,
    get: (url) => agent.get(url).set('Origin', ORIGIN),
    post: (url, body) => withHeaders(agent.post(url)).send(body ?? {}),
  };
}

async function hostSession(): Promise<Session> {
  await createHostAccount(HOST);
  const agent = request.agent(base);
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ role: 'host', email: HOST.email, password: HOST.password });
  if (res.status !== 200) throw new Error(`Host login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] || '';
  return wrap(agent, res.body.csrfToken, res.body.user, cookie);
}

async function studentSession(prnSuffix = '001'): Promise<Session> {
  const agent = request.agent(base);
  const res = await agent
    .post('/api/auth/register')
    .set('Origin', ORIGIN)
    .send(studentPayload({ prn: `STU${prnSuffix}`, email: `student${prnSuffix}@college.test` }));
  if (res.status !== 201) throw new Error(`Student register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] || '';
  return wrap(agent, res.body.csrfToken, res.body.user, cookie);
}

async function setupCompetition(host: Session, studentCount: number, durationSeconds = 1800) {
  const q1Res = await host.post('/api/questions', questionPayload({
    questionText: 'What is 2+2?',
    options: ['1', '2', '3', '4'],
    correctOption: 'D',
    difficulty: 'EASY',
    points: 10,
  }));
  if (q1Res.status !== 201) throw new Error(`q1 failed: ${q1Res.status} ${JSON.stringify(q1Res.body)}`);
  const q1 = (q1Res.body.question?._id || q1Res.body.question?.id) as string;

  const q2Res = await host.post('/api/questions', questionPayload({
    questionText: 'What is 5*5?',
    options: ['10', '25', '30', '35'],
    correctOption: 'B',
    difficulty: 'MEDIUM',
    timeLimitSeconds: 300,
    points: 20,
  }));
  if (q2Res.status !== 201) throw new Error(`q2 failed: ${q2Res.status} ${JSON.stringify(q2Res.body)}`);
  const q2 = (q2Res.body.question?._id || q2Res.body.question?.id) as string;

  const created = await host.post('/api/competitions', {
    name: 'Math Challenge Cup',
    durationSeconds,
    questionIds: [q1, q2],
    questionProgressionMode: 'AUTOMATIC',
  });
  if (created.status !== 201) throw new Error(`comp create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.competition.id as string;

  await host.post(`/api/competitions/${id}/open-registration`);

  const students: Session[] = [];
  for (let i = 0; i < studentCount; i += 1) {
    const s = await studentSession(String(i + 1).padStart(3, '0'));
    await s.post(`/api/competitions/${id}/join`);
    students.push(s);
  }

  return { id, q1, q2, students };
}

describe('PHASE 3 & 4: Host Registration & Start Flow', () => {
  it('opens registration and host can activate competition idempotently', async () => {
    const host = await hostSession();
    const { id, students } = await setupCompetition(host, 2);

    // Initial status should be WAITING (Registration Open)
    const statusBefore = await students[0]!.get(`/api/competitions/${id}/status`);
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.status).toBe('WAITING');
    expect(statusBefore.body.registrationStatus).toBe('OPEN');

    // Participant cannot start test before host activation
    const startEarly = await students[0]!.post(`/api/competitions/${id}/start-test`);
    expect(startEarly.status).toBe(400);
    expect(startEarly.body.error.code).toBe('COMPETITION_NOT_ACTIVE');

    // Host starts competition
    const startRes = await host.post(`/api/competitions/${id}/start`);
    expect(startRes.status).toBe(200);
    expect(startRes.body.ok).toBe(true);
    expect(startRes.body.status).toBe('ACTIVE');
    expect(startRes.body.startedAt).toBeDefined();

    // Duplicate start: prevented safely (idempotent / conflict error)
    const startAgain = await host.post(`/api/competitions/${id}/start`);
    expect([200, 409]).toContain(startAgain.status);

    // Status is now ACTIVE
    const statusAfter = await students[0]!.get(`/api/competitions/${id}/status`);
    expect(statusAfter.body.status).toBe('ACTIVE');
  });

  it('rejects unauthorized users from starting a competition', async () => {
    const host = await hostSession();
    const { id, students } = await setupCompetition(host, 1);

    // Student cannot start the competition
    const studentStart = await students[0]!.post(`/api/competitions/${id}/start`);
    expect(studentStart.status).toBe(403);

    // Another host cannot start someone else's competition
    await createHostAccount({ name: 'Other Host', email: 'other@mathhack.test', password: 'HostPassw0rd!' });
    const otherAgent = request.agent(base);
    const otherLogin = await otherAgent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ role: 'host', email: 'other@mathhack.test', password: 'HostPassw0rd!' });
    const otherHost = wrap(otherAgent, otherLogin.body.csrfToken, otherLogin.body.user, '');
    const otherStart = await otherHost.post(`/api/competitions/${id}/start`);
    expect(otherStart.status).toBe(403);
  });
});

describe('PHASE 5: Server-Sent Events (SSE) Stream', () => {
  it('allows authenticated registered participants to subscribe to SSE events', async () => {
    const host = await hostSession();
    const { id, students } = await setupCompetition(host, 1);

    // Subscribe via GET /api/competitions/:id/events
    const res = await students[0]!.get(`/api/competitions/${id}/events`)
      .set('Accept', 'text/event-stream')
      .buffer(false);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('rejects unauthenticated requests to the SSE stream', async () => {
    const host = await hostSession();
    const { id } = await setupCompetition(host, 0);

    const res = await request(base)
      .get(`/api/competitions/${id}/events`)
      .set('Origin', ORIGIN);

    expect(res.status).toBe(401);
  });
});

describe('PHASE 6 & 7: Individual Participant Exam Sessions & Independent Timers', () => {
  it('creates independent sessions and timers for participants starting at different times', async () => {
    const host = await hostSession();
    const { id, students } = await setupCompetition(host, 3, 1200);

    // Host starts competition
    await host.post(`/api/competitions/${id}/start`);

    // Participant 0 starts
    const startA = await students[0]!.post(`/api/competitions/${id}/start-test`);
    expect(startA.status).toBe(200);
    const sessionA = startA.body.session;
    expect(sessionA.status).toBe('ACTIVE');
    expect(sessionA.startedAt).toBeDefined();
    expect(sessionA.expiresAt).toBeDefined();

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Participant 1 starts later
    const startB = await students[1]!.post(`/api/competitions/${id}/start-test`);
    expect(startB.status).toBe(200);
    const sessionB = startB.body.session;

    // Verify independent start and expiration timestamps
    const startedA = new Date(sessionA.startedAt).getTime();
    const startedB = new Date(sessionB.startedAt).getTime();
    expect(startedB).toBeGreaterThanOrEqual(startedA);

    const expiresA = new Date(sessionA.expiresAt).getTime();
    const expiresB = new Date(sessionB.expiresAt).getTime();
    expect(expiresB).toBeGreaterThanOrEqual(expiresA);

    // Double-click / duplicate start request does NOT reset timestamps
    const startA_again = await students[0]!.post(`/api/competitions/${id}/start-test`);
    expect(startA_again.status).toBe(200);
    expect(startA_again.body.session.startedAt).toBe(sessionA.startedAt);
    expect(startA_again.body.session.expiresAt).toBe(sessionA.expiresAt);

    // Refresh / reload restores session and timer via my-session
    const mySessionA = await students[0]!.get(`/api/competitions/${id}/my-session`);
    expect(mySessionA.status).toBe(200);
    expect(mySessionA.body.session.sessionId).toBe(sessionA.sessionId);
    expect(mySessionA.body.session.expiresAt).toBe(sessionA.expiresAt);
    expect(mySessionA.body.session.remainingMs).toBeGreaterThan(0);
  });
});

describe('PHASE 8: Questions & Answer Submissions', () => {
  it('hides questions before exam start, reveals sanitized questions after start, and scores answers', async () => {
    const host = await hostSession();
    const { id, q1, students } = await setupCompetition(host, 1);
    await host.post(`/api/competitions/${id}/start`);

    // Participant cannot access questions before starting session
    const preQuestions = await students[0]!.get(`/api/competitions/${id}/questions`);
    expect(preQuestions.status).toBe(403);

    // Participant starts test
    const startRes = await students[0]!.post(`/api/competitions/${id}/start-test`);
    expect(startRes.status).toBe(200);
    expect(startRes.body.questions.length).toBe(2);

    // Questions do NOT reveal correctOption
    for (const q of startRes.body.questions) {
      expect(q.correctOption).toBeUndefined();
      expect(q.questionText).toBeDefined();
      expect(q.options.length).toBe(4);
    }

    // Submit correct answer for q1 ('D')
    const subRes = await students[0]!.post(`/api/competitions/${id}/submit`, {
      questionId: q1,
      selectedOption: 'D',
    });
    expect(subRes.status).toBe(200);
    expect(subRes.body.ok).toBe(true);
    expect(subRes.body.score).toBe(10);

    // Reject duplicate submission for same question
    const dupRes = await students[0]!.post(`/api/competitions/${id}/submit`, {
      questionId: q1,
      selectedOption: 'D',
    });
    expect(dupRes.status).toBe(409);

    // Complete the exam session
    const completeRes = await students[0]!.post(`/api/competitions/${id}/complete`);
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('COMPLETED');
    expect(completeRes.body.score).toBe(10);
  });
});
