/**
 * Drizzle mapping of migrations/0001_init.sql. The SQL file is the source of truth for constraints and indexes;
 * this file only describes the columns so queries are typed.
 */
import { bigserial, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { CompetitionSettings, Difficulty, OptionKey, QuestionSnapshot } from '../domain.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const hosts = pgTable('hosts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('ADMIN'),
  accountStatus: text('account_status').notNull().default('ACTIVE'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const students = pgTable('students', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prn: text('prn').notNull(),
  email: text('email').notNull(),
  department: text('department').notNull(),
  academicYear: text('academic_year').notNull(),
  passwordHash: text('password_hash').notNull(),
  rosterVerified: boolean('roster_verified').notNull().default(false),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  loginLockedUntil: ts('login_locked_until'),
  passwordChangedAt: ts('password_changed_at'),
  accountStatus: text('account_status').notNull().default('ACTIVE'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const importBatches = pgTable('import_batches', {
  id: text('id').primaryKey(),
  createdBy: text('created_by').notNull(),
  originalFilename: text('original_filename'),
  fileType: text('file_type').$type<'csv' | 'xlsx'>().notNull(),
  status: text('status').$type<'PREVIEW' | 'COMMITTING' | 'COMMITTED'>().notNull().default('PREVIEW'),
  totalRows: integer('total_rows').notNull(),
  validRows: jsonb('valid_rows').$type<unknown[]>().notNull().default([]),
  invalidRows: jsonb('invalid_rows').$type<unknown[]>().notNull().default([]),
  duplicateRows: jsonb('duplicate_rows').$type<unknown[]>().notNull().default([]),
  insertedCount: integer('inserted_count').notNull().default(0),
  committedAt: ts('committed_at'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const questions = pgTable('questions', {
  id: text('id').primaryKey(),
  questionText: text('question_text').notNull(),
  options: text('options').array().notNull(),
  correctOption: text('correct_option').$type<OptionKey>().notNull(),
  difficulty: text('difficulty').$type<Difficulty>().notNull(),
  timeLimitSeconds: integer('time_limit_seconds').notNull(),
  points: integer('points').notNull(),
  topic: text('topic').notNull().default(''),
  explanation: text('explanation').notNull().default(''),
  tags: text('tags').array().notNull().default([]),
  status: text('status').$type<'DRAFT' | 'ACTIVE'>().notNull().default('DRAFT'),
  fingerprint: text('fingerprint').notNull(),
  createdBy: text('created_by'),
  importBatchId: text('import_batch_id'),
  importedBy: text('imported_by'),
  importedAt: ts('imported_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type CompetitionStatus = 'DRAFT' | 'WAITING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export const competitions = pgTable('competitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdBy: text('created_by').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  status: text('status').$type<CompetitionStatus>().notNull().default('DRAFT'),
  questionProgressionMode: text('question_progression_mode').$type<'AUTOMATIC' | 'MANUAL'>().notNull().default('AUTOMATIC'),
  settings: jsonb('settings').$type<CompetitionSettings>().notNull().default({}),
  startedAt: ts('started_at'),
  endsAt: ts('ends_at'),
  completedAt: ts('completed_at'),
  completionReason: text('completion_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const competitionQuestions = pgTable(
  'competition_questions',
  {
    competitionId: text('competition_id').notNull(),
    questionId: text('question_id').notNull(),
    position: integer('position').notNull(),
    snapshot: jsonb('snapshot').$type<QuestionSnapshot | null>(),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.questionId] })],
);

export const participants = pgTable(
  'participants',
  {
    competitionId: text('competition_id').notNull(),
    studentId: text('student_id').notNull(),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at'),
    removedAt: ts('removed_at'),
    removedBy: text('removed_by'),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.studentId] })],
);

export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'COMPLETED';

export const examSessions = pgTable(
  'exam_sessions',
  {
    competitionId: text('competition_id').notNull(),
    studentId: text('student_id').notNull(),
    startedAt: ts('started_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    status: text('status').$type<SessionStatus>().notNull().default('ACTIVE'),
    finishedAt: ts('finished_at'),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.studentId] })],
);

export const answers = pgTable(
  'answers',
  {
    competitionId: text('competition_id').notNull(),
    studentId: text('student_id').notNull(),
    questionId: text('question_id').notNull(),
    difficulty: text('difficulty').$type<Difficulty>().notNull(),
    selectedOption: text('selected_option').$type<OptionKey | null>(),
    isCorrect: boolean('is_correct').notNull(),
    pointsAwarded: integer('points_awarded').notNull(),
    responseTimeMs: integer('response_time_ms'),
    submittedAt: ts('submitted_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.competitionId, t.studentId, t.questionId] })],
);

export const rosterEntries = pgTable('roster_entries', {
  prn: text('prn').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull().default(''),
  uploadedBy: text('uploaded_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: text('actor_id'),
  actorRole: text('actor_role').notNull(),
  action: text('action').notNull(),
  competitionId: text('competition_id'),
  details: jsonb('details').$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
