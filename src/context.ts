import type { Context } from 'hono';
import type { Db } from './db/client.js';
import type { AuthUser } from './domain.js';
import type { Bindings, Config } from './env.js';
import type { Realtime } from './realtime/client.js';
import { unauthenticated } from './lib/errors.js';

/** Everything a request handler needs, set once per request by the app middleware. */
export interface Services {
  db: Db;
  config: Config;
  realtime: Realtime;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Services & { auth?: AuthUser };
};

export type AppContext = Context<AppEnv>;

export const services = (c: AppContext): Services => ({ db: c.get('db'), config: c.get('config'), realtime: c.get('realtime') });

export function authOf(c: AppContext): AuthUser {
  const auth = c.get('auth');
  if (!auth) throw unauthenticated();
  return auth;
}
