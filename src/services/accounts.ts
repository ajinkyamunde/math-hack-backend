import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hosts, rosterEntries, students } from '../db/schema.js';
import type { AuthUser } from '../domain.js';
import type { Config } from '../env.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { AppError, conflict, forbidden, isUniqueViolation, uniqueViolationText, unauthenticated } from '../lib/errors.js';
import { iso, newId, normalizeEmail, normalizePrn } from '../lib/text.js';

type StudentRow = typeof students.$inferSelect;
type HostRow = typeof hosts.$inferSelect;

/** The public shape of a student, as the frontend expects it (Mongo-style _id). Never includes secrets. */
export function studentJson(student: StudentRow) {
  return {
    _id: student.id,
    name: student.name,
    prn: student.prn,
    email: student.email,
    department: student.department,
    academicYear: student.academicYear,
    rosterVerified: student.rosterVerified,
    accountStatus: student.accountStatus,
    createdAt: iso(student.createdAt),
    updatedAt: iso(student.updatedAt),
  };
}

export function hostJson(host: HostRow) {
  return {
    _id: host.id,
    name: host.name,
    email: host.email,
    role: host.role,
    accountStatus: host.accountStatus,
    createdAt: iso(host.createdAt),
    updatedAt: iso(host.updatedAt),
  };
}

/** Confirms the account behind a session still exists, is active, and has not had its password reset since. */
export async function loadActiveAccount(db: Db, user: AuthUser): Promise<StudentRow | HostRow> {
  const account =
    user.role === 'host'
      ? (await db.select().from(hosts).where(eq(hosts.id, user.id)).limit(1))[0]
      : (await db.select().from(students).where(eq(students.id, user.id)).limit(1))[0];
  if (!account) throw unauthenticated('Your account no longer exists.');
  if (account.accountStatus !== 'ACTIVE') throw forbidden('Your account is suspended.');
  const changedAt = 'passwordChangedAt' in account ? account.passwordChangedAt : null;
  if (changedAt && user.issuedAt !== undefined && user.issuedAt < Math.floor(changedAt.getTime() / 1000)) {
    throw unauthenticated('Your password was changed. Please sign in again.');
  }
  return account;
}

export interface StudentAccountFields {
  name: string;
  prn: string;
  email: string;
  department: string;
  academicYear: string;
  rosterVerified?: boolean;
}

/**
 * The one place student accounts are inserted, for self-registration and host-created participants alike:
 * same normalization, duplicate rules, unique indexes and Argon2id hashing.
 */
export async function createStudentAccount(db: Db, fields: StudentAccountFields, password: string): Promise<StudentRow> {
  const prn = normalizePrn(fields.prn);
  const email = normalizeEmail(fields.email);
  const [prnTaken, emailTaken] = await Promise.all([
    db.select({ id: students.id }).from(students).where(eq(students.prn, prn)).limit(1),
    db.select({ id: students.id }).from(students).where(eq(students.email, email)).limit(1),
  ]);
  if (prnTaken.length) throw conflict('An account with this PRN already exists.', { field: 'prn' });
  if (emailTaken.length) throw conflict('An account with this email already exists.', { field: 'email' });

  const passwordHash = await hashPassword(password);
  try {
    const [created] = await db
      .insert(students)
      .values({
        id: newId(),
        name: fields.name,
        prn,
        email,
        department: fields.department,
        academicYear: fields.academicYear,
        passwordHash,
        rosterVerified: fields.rosterVerified ?? false,
      })
      .returning();
    return created!;
  } catch (error) {
    // Unique indexes catch the race where two creations pass the existence check together.
    if (isUniqueViolation(error)) {
      const field = uniqueViolationText(error).includes('email') ? 'email' : 'prn';
      throw conflict(`An account with this ${field === 'email' ? 'email' : 'PRN'} already exists.`, { field });
    }
    throw error;
  }
}

export async function registerStudent(
  db: Db,
  config: Config,
  input: { name: string; prn: string; email: string; department: string; academicYear: string; password: string },
): Promise<StudentRow> {
  const prn = normalizePrn(input.prn);
  const email = normalizeEmail(input.email);
  let rosterVerified = false;
  if (config.rosterEnforced) {
    const [entry] = await db.select().from(rosterEntries).where(eq(rosterEntries.prn, prn)).limit(1);
    if (!entry || entry.email !== email) {
      throw new AppError(403, 'FORBIDDEN', 'This PRN and email pair is not on the official roster. Contact the organizers.');
    }
    rosterVerified = true;
  }
  const { password, ...fields } = input;
  return createStudentAccount(db, { ...fields, prn, email, rosterVerified }, password);
}

const INVALID_LOGIN = 'Invalid credentials.';

/** Consecutive failed sign-ins that lock a student account, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;

/**
 * Counts a failed sign-in atomically; the attempt that reaches the limit locks the account and restarts the count.
 * Per-account (not per-IP) on purpose: participant passwords are only 4 characters.
 */
async function recordFailedLogin(db: Db, studentId: string): Promise<void> {
  const lockUntil = new Date(Date.now() + LOGIN_LOCK_MS);
  await db
    .update(students)
    .set({
      loginLockedUntil: sql`CASE WHEN ${students.failedLoginAttempts} + 1 >= ${MAX_FAILED_LOGINS} THEN ${lockUntil.toISOString()}::timestamptz ELSE ${students.loginLockedUntil} END`,
      failedLoginAttempts: sql`CASE WHEN ${students.failedLoginAttempts} + 1 >= ${MAX_FAILED_LOGINS} THEN 0 ELSE ${students.failedLoginAttempts} + 1 END`,
    })
    .where(eq(students.id, studentId));
}

function lockedError(until: Date): AppError {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return new AppError(
    429,
    'RATE_LIMITED',
    `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask the host to reset your password.`,
  );
}

export async function loginStudent(db: Db, identifier: string, password: string): Promise<StudentRow> {
  const trimmed = identifier.trim();
  const where = trimmed.includes('@') ? eq(students.email, normalizeEmail(trimmed)) : eq(students.prn, normalizePrn(trimmed));
  const [student] = await db.select().from(students).where(where).limit(1);
  // A locked account is not checked at all, so guesses made during the lock teach an attacker nothing.
  if (student?.loginLockedUntil && student.loginLockedUntil.getTime() > Date.now()) throw lockedError(student.loginLockedUntil);
  const ok = await verifyPassword(student?.passwordHash, password);
  if (!student || !ok) {
    if (student) await recordFailedLogin(db, student.id);
    throw new AppError(401, 'UNAUTHENTICATED', INVALID_LOGIN);
  }
  if (student.accountStatus !== 'ACTIVE') throw forbidden('Your account is suspended.');
  if (student.failedLoginAttempts || student.loginLockedUntil) {
    await db.update(students).set({ failedLoginAttempts: 0, loginLockedUntil: null }).where(eq(students.id, student.id));
  }
  return student;
}

/**
 * Replaces a student's password. The old password stops working at once, any lock is cleared, and sessions
 * issued before the change are rejected by loadActiveAccount.
 */
export async function setStudentPassword(db: Db, studentId: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  // JWT iat has one-second resolution; rounding down keeps a session issued in the same second as the reset valid.
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const updated = await db
    .update(students)
    .set({ passwordHash, passwordChangedAt: changedAt, failedLoginAttempts: 0, loginLockedUntil: null, updatedAt: new Date() })
    .where(eq(students.id, studentId))
    .returning({ id: students.id });
  return updated.length === 1;
}

export async function loginHost(db: Db, email: string, password: string): Promise<HostRow> {
  const [host] = await db.select().from(hosts).where(eq(hosts.email, normalizeEmail(email))).limit(1);
  const ok = await verifyPassword(host?.passwordHash, password);
  if (!host || !ok) throw new AppError(401, 'UNAUTHENTICATED', INVALID_LOGIN);
  if (host.accountStatus !== 'ACTIVE') throw forbidden('This host account is suspended.');
  return host;
}

/** Used only by the create-host script; there is no HTTP route for host creation. */
export async function createHostAccount(db: Db, input: { name: string; email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const existing = await db.select({ id: hosts.id }).from(hosts).where(and(eq(hosts.email, email))).limit(1);
  if (existing.length) return { created: false, email };
  await db.insert(hosts).values({ id: newId(), name: input.name, email, passwordHash: await hashPassword(input.password), role: 'ADMIN' });
  return { created: true, email };
}
