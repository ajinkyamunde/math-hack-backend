import type { Db } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

interface AuditEntry {
  actorId?: string;
  actorRole: 'host' | 'student' | 'system';
  action: string;
  competitionId?: string;
  details?: Record<string, unknown>;
}

/** Audit writes never block or fail the action being audited. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole,
      action: entry.action,
      competitionId: entry.competitionId ?? null,
      details: entry.details ?? null,
    });
  } catch (error) {
    console.error('Failed to write audit log', entry.action, error);
  }
}
