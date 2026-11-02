import { Hono } from 'hono';
import type { AppEnv } from '../context.js';
import { authOf } from '../context.js';
import { jsonBody, requireAuth } from '../auth/middleware.js';
import { clearSessionCookie, csrfTokenFor, issueSession, setSessionCookie } from '../auth/session.js';
import { AppError, parse } from '../lib/errors.js';
import { hostJson, loadActiveAccount, loginHost, loginStudent, registerStudent, studentJson } from '../services/accounts.js';
import { recordAudit } from '../services/audit.js';
import { loginSchema, registerSchema } from '../validation/schemas.js';
import type { hosts, students } from '../db/schema.js';

export const authRoutes = new Hono<AppEnv>();

/** Optional Cloudflare rate limit per identifier; accounts also lock after repeated failures. */
async function limitAttempts(c: { env: AppEnv['Bindings'] }, key: string): Promise<void> {
  if (!c.env.AUTH_LIMITER) return;
  const { success } = await c.env.AUTH_LIMITER.limit({ key });
  if (!success) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.');
}

authRoutes.post('/register', async (c) => {
  const input = parse(registerSchema, await jsonBody(c));
  const config = c.get('config');
  const { confirmPassword: _confirm, ...fields } = input;
  const student = await registerStudent(c.get('db'), config, fields);
  const session = await issueSession(config, { id: student.id, role: 'student' });
  setSessionCookie(c, config, session.token);
  return c.json({ user: { ...studentJson(student), role: 'student' }, csrfToken: session.csrfToken }, 201);
});

authRoutes.post('/login', async (c) => {
  const input = parse(loginSchema, await jsonBody(c));
  const db = c.get('db');
  const config = c.get('config');
  if (input.role === 'host') {
    await limitAttempts(c, `host:${input.email.toLowerCase()}`);
    const host = await loginHost(db, input.email, input.password);
    const session = await issueSession(config, { id: host.id, role: 'host' });
    setSessionCookie(c, config, session.token);
    await recordAudit(db, { actorId: host.id, actorRole: 'host', action: 'host.login' });
    return c.json({ user: { ...hostJson(host), role: 'host' }, csrfToken: session.csrfToken });
  }
  await limitAttempts(c, `student:${input.identifier.toLowerCase()}`);
  const student = await loginStudent(db, input.identifier, input.password);
  const session = await issueSession(config, { id: student.id, role: 'student' });
  setSessionCookie(c, config, session.token);
  return c.json({ user: { ...studentJson(student), role: 'student' }, csrfToken: session.csrfToken });
});

authRoutes.post('/logout', (c) => {
  clearSessionCookie(c, c.get('config'));
  return c.body(null, 204);
});

authRoutes.get('/me', requireAuth, async (c) => {
  const auth = authOf(c);
  const account = await loadActiveAccount(c.get('db'), auth);
  const user =
    auth.role === 'host'
      ? { ...hostJson(account as typeof hosts.$inferSelect), role: 'host' }
      : { ...studentJson(account as typeof students.$inferSelect), role: 'student' };
  return c.json({ user, csrfToken: await csrfTokenFor(c.get('config'), auth.sessionId) });
});
