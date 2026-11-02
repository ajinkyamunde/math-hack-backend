/** The MongoDB import, run against documents shaped like the old Mongoose models, then used through the API. */
import { describe, expect, it } from 'vitest';
import { importFromMongo, type SourceDb } from '../scripts/mongoImport.js';
import { createHarness } from './harness.js';

// Real Argon2id hash (argon2-cffi, same PHC format the Node backend wrote) of "LegacyPass#2026".
const LEGACY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$o2GRWtLdizJ88qqDQAhpkg$0sAWzcFZQHWauAf6s1TOKT6+tRh2fl0u/Pw3SWGqih0';
const t = (iso: string) => new Date(iso);

const HOST = '650000000000000000000001';
const S1 = '650000000000000000000011';
const S2 = '650000000000000000000012';
const Q1 = '650000000000000000000021';
const Q2 = '650000000000000000000022';
const COMP = '650000000000000000000031';

const snapshot = (text: string, correct: string, difficulty: string, points: number) => ({
  questionText: text, options: ['1', '2', '3', '4'], correctOption: correct, difficulty, timeLimitSeconds: 25, points, topic: '', explanation: '',
});

const collections: Record<string, Record<string, any>[]> = {
  hosts: [{ _id: HOST, name: 'Old Host', email: 'Host@College.edu', passwordHash: LEGACY_HASH, role: 'ADMIN', accountStatus: 'ACTIVE', createdAt: t('2026-09-01T00:00:00Z') }],
  students: [
    { _id: S1, name: 'Asha', prn: 'VIT2026001', email: 'asha@college.edu', department: 'CSE', academicYear: 'SE', passwordHash: LEGACY_HASH, rosterVerified: false, emailVerified: false },
    { _id: S2, name: 'Ravi', prn: 'VIT2026002', email: 'ravi@college.edu', department: 'CSE', academicYear: 'SE', passwordHash: LEGACY_HASH },
  ],
  questions: [
    { _id: Q1, questionText: 'One?', options: ['1', '2', '3', '4'], correctOption: 'A', difficulty: 'EASY', timeLimitSeconds: 25, points: 10, topic: 'Basics', explanation: '', tags: ['x'], status: 'ACTIVE', fingerprint: 'f1', createdBy: HOST },
    { _id: Q2, questionText: 'Two?', options: ['1', '2', '3', '4'], correctOption: 'B', difficulty: 'MEDIUM', timeLimitSeconds: 300, points: 20, topic: '', explanation: '', tags: [], status: 'ACTIVE', fingerprint: 'f2', createdBy: HOST },
  ],
  competitions: [
    {
      _id: COMP, name: 'October Cup', description: '', createdBy: HOST, durationSeconds: 1800, status: 'COMPLETED', questionProgressionMode: 'AUTOMATIC',
      settings: { revealAnswers: true }, startedAt: t('2026-10-20T10:00:00Z'), endsAt: t('2026-10-20T10:30:00Z'), completedAt: t('2026-10-20T10:30:00Z'), completionReason: 'TIMER',
      queue: [
        { questionId: Q1, order: 0, status: 'CLOSED', snapshot: snapshot('One?', 'A', 'EASY', 10) },
        { questionId: Q2, order: 1, status: 'CLOSED', snapshot: snapshot('Two?', 'B', 'MEDIUM', 20) },
      ],
    },
  ],
  participants: [
    { competitionId: COMP, studentId: S1, registrationStatus: 'REGISTERED', joinedAt: t('2026-10-20T09:50:00Z') },
    { competitionId: COMP, studentId: S2, registrationStatus: 'REGISTERED', joinedAt: t('2026-10-20T09:55:00Z') },
    { competitionId: COMP, studentId: '650000000000000000000099', registrationStatus: 'REGISTERED' }, // deleted student: skipped
  ],
  removedparticipants: [],
  examsessions: [
    { competitionId: COMP, studentId: S1, startedAt: t('2026-10-20T10:01:00Z'), expiresAt: t('2026-10-20T10:31:00Z'), status: 'SUBMITTED', submittedAt: t('2026-10-20T10:10:00Z') },
  ],
  attempts: [
    { competitionId: COMP, questionId: Q1, studentId: S1, difficulty: 'EASY', selectedOption: 'A', isCorrect: true, responseTimeMs: 4000, pointsAwarded: 10, submittedAt: t('2026-10-20T10:02:00Z'), timedOut: false },
    { competitionId: COMP, questionId: Q2, studentId: S1, difficulty: 'MEDIUM', selectedOption: 'B', isCorrect: true, responseTimeMs: 9000.4, pointsAwarded: 20, submittedAt: t('2026-10-20T10:05:00Z'), timedOut: false },
    { competitionId: COMP, questionId: Q1, studentId: S2, difficulty: 'EASY', selectedOption: null, isCorrect: false, responseTimeMs: null, pointsAwarded: 0, submittedAt: null, timedOut: true },
  ],
  rosterentries: [{ prn: 'VIT2026001', email: 'asha@college.edu', name: 'Asha', uploadedBy: HOST }],
};

const source: SourceDb = { collection: (name) => ({ find: () => ({ toArray: async () => collections[name] ?? [] }) }) };

describe('MongoDB import', () => {
  it('copies the old data, keeps IDs and passwords, and the API serves it', async () => {
    const h = await createHarness();
    const target = { query: (text: string, params?: unknown[]) => h.pg.query(text, params as any[]) as Promise<{ rows: unknown[] }> };
    const counts = await importFromMongo(source, target, () => undefined);
    expect(counts).toMatchObject({ hosts: 1, students: 2, questions: 2, competitions: 1, competition_questions: 2, participants: 2, exam_sessions: 1, answers: 2, roster_entries: 1 });

    // Re-running adds nothing.
    const again = await importFromMongo(source, target, () => undefined);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);

    // Old accounts sign in with their old passwords (email is matched case-insensitively).
    const host = h.client();
    expect((await host.post('/api/auth/login', { role: 'host', email: 'host@college.edu', password: 'LegacyPass#2026' })).status).toBe(200);
    const asha = h.client();
    const login = await asha.post('/api/auth/login', { role: 'student', identifier: 'VIT2026001', password: 'LegacyPass#2026' });
    expect(login.data.user._id).toBe(S1);

    // Historical results are intact.
    const board = await host.get(`/api/competitions/${COMP}/leaderboard`);
    expect(board.data.entries.map((e: { name: string; totalPoints: number }) => [e.name, e.totalPoints])).toEqual([
      ['Asha', 30],
      ['Ravi', 0],
    ]);
    const mine = await asha.get(`/api/competitions/${COMP}/results`);
    expect(mine.data.me).toEqual({ prn: 'VIT2026001', attempted: 2, correct: 2, incorrect: 0, unanswered: 0 });
    const history = await asha.get('/api/students/me/history');
    expect(history.data.items[0]).toMatchObject({ name: 'October Cup', finalScore: 30 });
  });
});
