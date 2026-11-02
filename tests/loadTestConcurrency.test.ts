import request from 'supertest';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.js';
import { createHostAccount } from '../src/services/authService.js';
import { HOST, ORIGIN, questionPayload, studentPayload } from './helpers.js';
import { ExamSession } from '../src/models/ExamSession.js';

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
  const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] || '';
  return wrap(agent, res.body.csrfToken, res.body.user, cookie);
}

async function studentSession(index: number): Promise<Session> {
  const agent = request.agent(base);
  const suffix = String(index).padStart(4, '0');
  const res = await agent
    .post('/api/auth/register')
    .set('Origin', ORIGIN)
    .send(studentPayload({ prn: `LOAD${suffix}`, email: `load${suffix}@college.test` }));
  const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] || '';
  return wrap(agent, res.body.csrfToken, res.body.user, cookie);
}

async function setupLoadCompetition(host: Session, count: number) {
  const q1Res = await host.post('/api/questions', questionPayload({
    questionText: 'Evaluate integral of 2x dx from 0 to 4',
    options: ['8', '12', '16', '20'],
    correctOption: 'C',
    difficulty: 'EASY',
    points: 10,
  }));
  const q1 = (q1Res.body.question?._id || q1Res.body.question?.id) as string;

  const q2Res = await host.post('/api/questions', questionPayload({
    questionText: 'Find determinant of 2x2 matrix [[3, 1], [2, 4]]',
    options: ['8', '10', '12', '14'],
    correctOption: 'B',
    difficulty: 'MEDIUM',
    timeLimitSeconds: 300,
    points: 20,
  }));
  const q2 = (q2Res.body.question?._id || q2Res.body.question?.id) as string;

  const created = await host.post('/api/competitions', {
    name: `Load Test Arena (${count} users)`,
    durationSeconds: 1800,
    questionIds: [q1, q2],
    questionProgressionMode: 'AUTOMATIC',
  });
  const id = created.body.competition.id as string;

  await host.post(`/api/competitions/${id}/open-registration`);

  // Register participants in batches
  const students: Session[] = [];
  const batchSize = 10;
  for (let i = 0; i < count; i += batchSize) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(batchSize, count - i) }, (_, k) => studentSession(i + k + 1)),
    );
    await Promise.all(chunk.map((s) => s.post(`/api/competitions/${id}/join`)));
    students.push(...chunk);
  }

  return { id, q1, q2, students };
}

describe('PHASE 14: Concurrency & Load Testing (30 & 50 Participants)', () => {
  it('handles 30 simultaneous participants starting at different times and submitting answers', async () => {
    const count = 30;
    const host = await hostSession();
    const { id, q1, students } = await setupLoadCompetition(host, count);

    // Host starts competition
    await host.post(`/api/competitions/${id}/start`);

    const startTimes: number[] = [];
    const latencies: number[] = [];
    let errors = 0;

    // Simulate staggered simultaneous start-test requests (spread across 0-500ms)
    const startResults = await Promise.all(
      students.map(async (student, idx) => {
        if (idx % 3 !== 0) {
          await new Promise((r) => setTimeout(r, (idx % 10) * 40));
        }
        const t0 = performance.now();
        try {
          const res = await student.post(`/api/competitions/${id}/start-test`);
          const t1 = performance.now();
          latencies.push(t1 - t0);
          if (res.status === 200) {
            startTimes.push(new Date(res.body.session.startedAt).getTime());
            return { ok: true, session: res.body.session };
          }
          errors += 1;
          return { ok: false, error: res.body };
        } catch {
          errors += 1;
          return { ok: false };
        }
      }),
    );

    const successfulStarts = startResults.filter((r) => r.ok);
    expect(successfulStarts.length).toBe(count);
    expect(errors).toBe(0);

    const avgStartLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`[Load Test - 30 Participants] Average start-test latency: ${avgStartLatency.toFixed(2)}ms (min: ${Math.min(...latencies).toFixed(2)}ms, max: ${Math.max(...latencies).toFixed(2)}ms)`);

    // Verify 30 unique sessions exist in database
    const dbSessionsCount = await ExamSession.countDocuments({
      competitionId: new mongoose.Types.ObjectId(id),
    });
    expect(dbSessionsCount).toBe(count);

    // Simulate concurrent answer submissions from all 30 participants
    const subLatencies: number[] = [];
    let subErrors = 0;

    const subResults = await Promise.all(
      students.map(async (student) => {
        const t0 = performance.now();
        const res = await student.post(`/api/competitions/${id}/submit`, {
          questionId: q1,
          selectedOption: 'C',
        });
        const t1 = performance.now();
        subLatencies.push(t1 - t0);
        if (res.status === 200 && res.body.ok) return true;
        subErrors += 1;
        return false;
      }),
    );

    const successfulSubs = subResults.filter(Boolean);
    expect(successfulSubs.length).toBe(count);
    expect(subErrors).toBe(0);

    const avgSubLatency = subLatencies.reduce((a, b) => a + b, 0) / subLatencies.length;
    console.log(`[Load Test - 30 Participants] Average submit latency: ${avgSubLatency.toFixed(2)}ms (min: ${Math.min(...subLatencies).toFixed(2)}ms, max: ${Math.max(...subLatencies).toFixed(2)}ms)`);
  });

  it('handles 50 simultaneous participants with concurrent starts and answer submissions', async () => {
    const count = 50;
    const host = await hostSession();
    const { id, q1, students } = await setupLoadCompetition(host, count);

    // Host starts competition
    await host.post(`/api/competitions/${id}/start`);

    const latencies: number[] = [];
    let errors = 0;

    // 50 concurrent start requests
    const startResults = await Promise.all(
      students.map(async (student, idx) => {
        await new Promise((r) => setTimeout(r, (idx % 12) * 30));
        const t0 = performance.now();
        const res = await student.post(`/api/competitions/${id}/start-test`);
        const t1 = performance.now();
        latencies.push(t1 - t0);
        if (res.status === 200) return true;
        errors += 1;
        return false;
      }),
    );

    expect(startResults.filter(Boolean).length).toBe(count);
    expect(errors).toBe(0);

    const avgStartLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`[Load Test - 50 Participants] Average start-test latency: ${avgStartLatency.toFixed(2)}ms (min: ${Math.min(...latencies).toFixed(2)}ms, max: ${Math.max(...latencies).toFixed(2)}ms)`);

    // Verify 50 unique sessions in database
    const dbSessionsCount = await ExamSession.countDocuments({
      competitionId: new mongoose.Types.ObjectId(id),
    });
    expect(dbSessionsCount).toBe(count);

    // 50 concurrent submissions
    const subLatencies: number[] = [];
    const subResults = await Promise.all(
      students.map(async (student) => {
        const t0 = performance.now();
        const res = await student.post(`/api/competitions/${id}/submit`, {
          questionId: q1,
          selectedOption: 'C',
        });
        const t1 = performance.now();
        subLatencies.push(t1 - t0);
        return res.status === 200 && res.body.ok;
      }),
    );

    expect(subResults.filter(Boolean).length).toBe(count);
    const avgSubLatency = subLatencies.reduce((a, b) => a + b, 0) / subLatencies.length;
    console.log(`[Load Test - 50 Participants] Average submit latency: ${avgSubLatency.toFixed(2)}ms (min: ${Math.min(...subLatencies).toFixed(2)}ms, max: ${Math.max(...subLatencies).toFixed(2)}ms)`);
  });
});
