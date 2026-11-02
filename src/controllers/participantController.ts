import type { Request, Response } from 'express';
import { Host } from '../models/Host.js';
import { recordAudit } from '../services/auditService.js';
import { buildParticipantView, participantExportFilename, writeParticipantWorkbook } from '../services/participantService.js';
import {
  deleteAllParticipants,
  deleteBulkParticipants,
  deleteSingleParticipant,
  undoDeleteParticipants,
} from '../services/participantManagementService.js';
import type { ParticipantQuery } from '../validation/participantSchemas.js';

const id = (req: Request): string => String(req.params.id);

/** Host-only (route-guarded by role and competition ownership). */
export async function list(req: Request, res: Response): Promise<void> {
  const view = await buildParticipantView(id(req), req.query as unknown as ParticipantQuery);
  res.setHeader('Cache-Control', 'no-store');
  res.json(view);
}

/** Host-only Excel export of the same filtered list the host is looking at. */
export async function exportXlsx(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ParticipantQuery;
  const [view, host] = await Promise.all([buildParticipantView(id(req), query), Host.findById(req.auth!.id).select('email').lean()]);
  await recordAudit({
    actorId: req.auth!.id,
    actorRole: 'host',
    action: 'participants.export',
    competitionId: id(req),
    details: { format: 'xlsx', rows: view.rows.length },
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${participantExportFilename(view)}"`);
  res.setHeader('Cache-Control', 'no-store');
  await writeParticipantWorkbook(view, query, host?.email ?? 'host', res);
  res.end();
}

/** Deletes a single participant from the competition. */
export async function deleteSingle(req: Request, res: Response): Promise<void> {
  const competitionId = id(req);
  const studentId = String(req.params.studentId);
  const result = await deleteSingleParticipant(competitionId, studentId, req.auth!.id);
  res.json({ ok: true, ...result });
}

/** Bulk deletes selected participants from the competition. */
export async function deleteBulk(req: Request, res: Response): Promise<void> {
  const competitionId = id(req);
  const { studentIds } = req.body as { studentIds: string[] };
  const result = await deleteBulkParticipants(competitionId, studentIds, req.auth!.id);
  res.json({ ok: true, ...result });
}

/** Deletes all participants in the competition. */
export async function deleteAll(req: Request, res: Response): Promise<void> {
  const competitionId = id(req);
  const result = await deleteAllParticipants(competitionId, req.auth!.id);
  res.json({ ok: true, ...result });
}

/** Undoes a recent participant deletion (within 10-15s window). */
export async function undoDelete(req: Request, res: Response): Promise<void> {
  const competitionId = id(req);
  const { studentIds } = (req.body ?? {}) as { studentIds?: string[] };
  const result = await undoDeleteParticipants(competitionId, req.auth!.id, studentIds);
  res.json({ ok: true, ...result });
}
