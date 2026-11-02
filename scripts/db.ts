/** Shared helpers for the Node scripts: read DATABASE_URL from the environment or .dev.vars. */
import { existsSync, readFileSync } from 'node:fs';
import { neonConfig, Pool } from '@neondatabase/serverless';

export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync('.dev.vars')) {
    const line = readFileSync('.dev.vars', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
  }
  throw new Error('Set DATABASE_URL (your Neon connection string), or put it in .dev.vars.');
}

/** A WebSocket pool, which (unlike the HTTP driver) can run multi-statement SQL files. */
export function pool(): Pool {
  neonConfig.webSocketConstructor = globalThis.WebSocket;
  return new Pool({ connectionString: databaseUrl() });
}
