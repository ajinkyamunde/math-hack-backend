import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context.js';
import { AppError, badRequest, forbidden, unauthenticated } from '../lib/errors.js';
import { loadActiveAccount } from '../services/accounts.js';
import { isValidCsrfToken, readSessionCookie, verifySessionToken } from './session.js';

/** Development origins the Vite dev server may use. Production origins come from FRONTEND_URL / CORS_EXTRA_ORIGINS. */
export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'];

export function isAllowedOrigin(allowed: string[], origin: string | undefined): boolean {
  if (!origin) return true;
  return allowed.includes(origin) || DEV_ORIGINS.includes(origin);
}

/** Verifies the HTTP-only session cookie and confirms the account is still active. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) throw unauthenticated();
  const user = await verifySessionToken(c.get('config'), token);
  await loadActiveAccount(c.get('db'), user);
  c.set('auth', user);
  await next();
};

export const requireHost: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth')?.role !== 'host') throw forbidden('Host access required.');
  await next();
};

export const requireStudent: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth')?.role !== 'student') throw forbidden('This action is only available to students.');
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Defense in depth against CSRF, applied to every API route:
 *  1. State-changing requests from browsers must come from an allowed frontend origin.
 *  2. Requests carrying a session cookie must also echo the session-bound CSRF token in X-CSRF-Token.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const config = c.get('config');
  let origin = c.req.header('origin');
  if (!origin) {
    const referer = c.req.header('referer');
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = 'invalid';
      }
    }
  }
  if (!isAllowedOrigin(config.allowedOrigins, origin)) throw new AppError(403, 'CSRF_FAILED', 'Request origin is not allowed.');

  const token = readSessionCookie(c);
  if (token) {
    let sessionId: string;
    try {
      sessionId = (await verifySessionToken(config, token)).sessionId;
    } catch {
      // An expired cookie is harmless here; authentication rejects it if the route needs a session.
      return next();
    }
    if (!(await isValidCsrfToken(config, sessionId, c.req.header('x-csrf-token')))) {
      throw new AppError(403, 'CSRF_FAILED', 'Security token missing or invalid. Refresh the page and try again.');
    }
  }
  return next();
};

/** Reads a JSON body (empty body = {}), rejecting malformed or oversized input with the API's error shape. */
export async function jsonBody(c: { req: { header(name: string): string | undefined; text(): Promise<string> } }, limitBytes = 100 * 1024): Promise<unknown> {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > limitBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  const text = await c.req.text();
  if (text.length > limitBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Malformed JSON body.');
  }
}

/** Reads the single uploaded file from a multipart form. */
export async function uploadedFile(c: { req: { header(name: string): string | undefined; formData(): Promise<FormData> } }, maxBytes: number, missingMessage: string): Promise<File> {
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > maxBytes + 64 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The uploaded file is too large.');
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest(missingMessage);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw badRequest(missingMessage);
  if (file.size > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The uploaded file is too large.');
  return file;
}
