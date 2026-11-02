import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../env.js';
import type { AuthUser, Role } from '../domain.js';
import { unauthenticated } from '../lib/errors.js';
import { base64UrlDecode, base64UrlEncode } from '../lib/text.js';

export const SESSION_COOKIE = 'mh_session';

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, data: string): Promise<string> {
  return base64UrlEncode(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data)));
}

const encodeJson = (value: unknown) => base64UrlEncode(encoder.encode(JSON.stringify(value)));

/**
 * HS256 JWT with the same claims and issuer as the original backend's jsonwebtoken sessions
 * ({ role, sid, sub, iat, exp, iss: "mathhack" }). With the same SESSION_SECRET, sessions issued by the old
 * backend stay valid across the switch.
 */
export async function issueSession(config: Config, user: { id: string; role: Role }) {
  const sessionId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const iat = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJson({ role: user.role, sid: sessionId, iat, exp: iat + config.sessionTtlHours * 3600, iss: 'mathhack', sub: user.id });
  const token = `${header}.${payload}.${await hmac(config.sessionSecret, `${header}.${payload}`)}`;
  return { token, sessionId, csrfToken: await csrfTokenFor(config, sessionId) };
}

export async function verifySessionToken(config: Config, token: string): Promise<AuthUser> {
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) throw new Error('malformed');
    const headerJson = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: string };
    if (headerJson.alg !== 'HS256') throw new Error('alg');
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(config.sessionSecret), base64UrlDecode(signature), encoder.encode(`${header}.${payload}`));
    if (!valid) throw new Error('signature');
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      sub?: string;
      role?: string;
      sid?: string;
      iat?: number;
      exp?: number;
      iss?: string;
    };
    if (claims.iss !== 'mathhack') throw new Error('issuer');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('expired');
    if (!claims.sub || (claims.role !== 'student' && claims.role !== 'host') || !claims.sid) throw new Error('claims');
    return { id: claims.sub, role: claims.role, sessionId: claims.sid, issuedAt: claims.iat };
  } catch {
    throw unauthenticated('Your session has expired. Please sign in again.');
  }
}

/** CSRF token bound to the session: HMAC(secret, "csrf:" + sessionId). Identical to the original backend. */
export function csrfTokenFor(config: Config, sessionId: string): Promise<string> {
  return hmac(config.sessionSecret, `csrf:${sessionId}`);
}

export async function isValidCsrfToken(config: Config, sessionId: string, provided: string | undefined): Promise<boolean> {
  if (!provided) return false;
  const expected = await csrfTokenFor(config, sessionId);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

function cookieOptions(config: Config) {
  const sameSite = config.cookieSameSite === 'none' ? 'None' : config.cookieSameSite === 'strict' ? 'Strict' : 'Lax';
  return {
    httpOnly: true,
    // Always secure on Workers (HTTPS); wrangler dev serves localhost, which browsers treat as secure too.
    secure: true,
    sameSite,
    domain: config.cookieDomain,
    path: '/',
  } as const;
}

export function setSessionCookie(c: Context, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions(config), maxAge: config.sessionTtlHours * 3600 });
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(config));
}

export const readSessionCookie = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE) || undefined;
