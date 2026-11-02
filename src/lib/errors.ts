import type { z } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'ALREADY_SUBMITTED'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'PARTICIPANT_REMOVED'
  | 'NOT_REGISTERED'
  | 'COMPETITION_NOT_ACTIVE'
  | 'NO_ACTIVE_SESSION'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_EXPIRED';

/** An error whose message is safe to show to the client. Rendered as { error: { code, message, details } }. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const participantRemoved = () =>
  new AppError(403, 'PARTICIPANT_REMOVED', 'Your access to this competition has been removed by the host.');

export function formatZodIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message }));
}

/** Parses input with a zod schema, throwing the API's standard 400 with per-field details. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw badRequest('Please correct the highlighted fields.', formatZodIssues(result.error));
  return result.data;
}

/** Postgres unique-violation (23505), from either the Neon driver or PGlite. */
export function isUniqueViolation(error: unknown): error is { code: '23505'; constraint?: string; detail?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The constraint or detail text of a unique violation, searched through wrapped errors. */
export function uniqueViolationText(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; constraint?: string; detail?: string };
    if (e.code === '23505') return `${e.constraint ?? ''} ${e.detail ?? ''}`;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}
