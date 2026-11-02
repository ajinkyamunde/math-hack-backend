/**
 * Runs the real Hono app against PGlite (PostgreSQL compiled to WebAssembly) with the production migration,
 * and records live events instead of sending them through a Durable Object.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type { Bindings } from '../src/env.js';
import type { Realtime, RoomMessage } from '../src/realtime/client.js';

export const ORIGIN = 'http://localhost:5173';
export const SECRET = 'test-secret-that-is-long-enough-for-hmac-signing-0123456789';

export interface Recorded {
  competitionId: string;
  message: RoomMessage;
}

export async function createHarness() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const db = drizzle(pg, { schema }) as unknown as Db;

  const events: Recorded[] = [];
  const online = new Map<string, Set<string>>();
  const signals = { sessionsChanged: 0, answered: 0, kicked: [] as string[] };
  const realtime: Realtime = {
    publish: (competitionId, messages) => messages.forEach((message) => events.push({ competitionId, message })),
    presence: async (competitionId) => [...(online.get(competitionId) ?? [])],
    connect: async () => new Response('event: connected\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    kick: (_competitionId, ids) => signals.kicked.push(...ids),
    sessionsChanged: () => {
      signals.sessionsChanged += 1;
    },
    answered: () => {
      signals.answered += 1;
    },
  };

  const app = createApp({ db: () => db, realtime: () => realtime });
  const env = {
    DATABASE_URL: 'postgresql://pglite/test',
    SESSION_SECRET: SECRET,
    FRONTEND_URL: ORIGIN,
    SESSION_TTL_HOURS: '12',
    COOKIE_SAME_SITE: 'lax',
    ROSTER_ENFORCED: 'false',
    ALLOWED_EMAIL_DOMAINS: '',
  } as unknown as Bindings;

  /** A browser-like client: keeps the session cookie and sends the CSRF token on writes. */
  function client() {
    let cookie = '';
    let csrf = '';
    async function call(method: string, path: string, body?: unknown, extra: RequestInit = {}) {
      const headers = new Headers(extra.headers);
      headers.set('origin', ORIGIN);
      if (cookie) headers.set('cookie', cookie);
      if (csrf && method !== 'GET') headers.set('x-csrf-token', csrf);
      let payload: BodyInit | undefined = extra.body ?? undefined;
      if (body !== undefined) {
        headers.set('content-type', 'application/json');
        payload = JSON.stringify(body);
      }
      const res = await app.request(path, { method, headers, body: payload }, env);
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const value = setCookie.split(';')[0]!;
        cookie = value.endsWith('=') ? '' : value;
      }
      const type = res.headers.get('content-type') ?? '';
      const data = type.includes('json') ? ((await res.json()) as Record<string, any>) : null;
      if (data?.csrfToken) csrf = data.csrfToken as string;
      return { status: res.status, data: data as any, res };
    }
    return {
      get: (path: string) => call('GET', path),
      post: (path: string, body?: unknown) => call('POST', path, body ?? {}),
      put: (path: string, body?: unknown) => call('PUT', path, body),
      patch: (path: string, body?: unknown) => call('PATCH', path, body),
      del: (path: string) => call('DELETE', path),
      upload: (path: string, file: File) => {
        const form = new FormData();
        form.append('file', file);
        return call('POST', path, undefined, { body: form });
      },
      raw: call,
      setCookie: (value: string) => {
        cookie = value;
      },
    };
  }

  return { pg, db, app, env, events, online, signals, client };
}
