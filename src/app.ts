import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { sql } from 'drizzle-orm';
import type { AppEnv } from './context.js';
import type { Db } from './db/client.js';
import type { Bindings } from './env.js';
import { getConfig } from './env.js';
import { csrfProtection, isAllowedOrigin } from './auth/middleware.js';
import { AppError } from './lib/errors.js';
import type { Realtime } from './realtime/client.js';
import { authRoutes } from './routes/auth.js';
import { competitionRoutes } from './routes/competitions.js';
import { hostRoutes, studentRoutes } from './routes/people.js';
import { questionRoutes } from './routes/questions.js';

/** How the app reaches the database and the live layer. The Worker passes Neon + Durable Objects; tests pass PGlite + a recorder. */
export interface AppDeps {
  db: (env: Bindings) => Db;
  realtime: (env: Bindings, waitUntil: (promise: Promise<unknown>) => void) => Realtime;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const dbCache = new WeakMap<object, Db>();

  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status as 400);
    }
    console.error('Unhandled request error', c.req.method, c.req.path, error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  app.use('*', async (c, next) => {
    const config = getConfig(c.env);
    let db = dbCache.get(c.env);
    if (!db) {
      db = deps.db(c.env);
      dbCache.set(c.env, db);
    }
    const waitUntil = (promise: Promise<unknown>) => {
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        void promise; // no execution context (tests)
      }
    };
    c.set('config', config);
    c.set('db', db);
    c.set('realtime', deps.realtime(c.env, waitUntil));
    await next();
  });

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use(
    '/api/*',
    cors({
      origin: (origin, c) => (isAllowedOrigin(c.get('config').allowedOrigins, origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-CSRF-Token', 'Accept', 'Authorization'],
      exposeHeaders: ['Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.use('/api/*', csrfProtection);

  app.get('/api/health', async (c) => {
    try {
      await c.get('db').execute(sql`select 1`);
      return c.json({ status: 'ok', database: 'connected', time: new Date().toISOString() });
    } catch {
      return c.json({ status: 'degraded', database: 'disconnected', time: new Date().toISOString() }, 503);
    }
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/questions', questionRoutes);
  app.route('/api/competitions', competitionRoutes);
  app.route('/api/students', studentRoutes);
  app.route('/api/host', hostRoutes);

  return app;
}
