import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

/** Driver-neutral database type: Neon over HTTP in the Worker, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Neon's HTTP driver sends each query as one HTTPS request: no connection to open or pool to exhaust, which
 * suits Workers. Every statement this API runs is a single atomic SQL statement, so no interactive
 * transactions are needed.
 */
export function createNeonDb(databaseUrl: string): Db {
  return drizzle(neon(databaseUrl), { schema }) as unknown as Db;
}

export { schema };

/** Rows of a raw `db.execute(sql...)` result, for either driver. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
