import { z } from 'zod';

/** Worker bindings: plain vars and secrets from wrangler.toml / `wrangler secret put`, plus the Durable Object. */
export interface Bindings {
  DATABASE_URL: string;
  SESSION_SECRET: string;
  FRONTEND_URL: string;
  CORS_EXTRA_ORIGINS?: string;
  SESSION_TTL_HOURS?: string;
  COOKIE_SAME_SITE?: string;
  COOKIE_DOMAIN?: string;
  ROSTER_ENFORCED?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  COMPETITION_ROOM: DurableObjectNamespace;
  AUTH_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const configSchema = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// connection string'),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    FRONTEND_URL: z.string().url(),
    CORS_EXTRA_ORIGINS: z.string().optional(),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_DOMAIN: z.string().optional().transform((value) => value || undefined),
    ROSTER_ENFORCED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  })
  .transform((env) => {
    const origins = new Set<string>([new URL(env.FRONTEND_URL).origin]);
    for (const entry of list(env.CORS_EXTRA_ORIGINS)) {
      try {
        origins.add(new URL(entry).origin);
      } catch {
        throw new Error('CORS_EXTRA_ORIGINS must be a comma-separated list of http(s) URLs');
      }
    }
    return {
      databaseUrl: env.DATABASE_URL,
      sessionSecret: env.SESSION_SECRET,
      allowedOrigins: [...origins],
      sessionTtlHours: env.SESSION_TTL_HOURS,
      cookieSameSite: env.COOKIE_SAME_SITE,
      cookieDomain: env.COOKIE_DOMAIN,
      rosterEnforced: env.ROSTER_ENFORCED,
      allowedEmailDomains: list(env.ALLOWED_EMAIL_DOMAINS).map((domain) => domain.toLowerCase()),
    };
  });

export type Config = z.output<typeof configSchema>;

const cache = new WeakMap<object, Config>();

/** Validates the bindings once per isolate. Error messages name variables but never echo their values. */
export function getConfig(env: Bindings): Config {
  const cached = cache.get(env);
  if (cached) return cached;
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid Worker configuration:\n  - ${issues.join('\n  - ')}`);
  }
  cache.set(env, result.data);
  return result.data;
}
