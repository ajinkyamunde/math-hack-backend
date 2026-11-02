import mongoose, { Types } from 'mongoose';
import { Attempt } from '../models/Attempt.js';
import { Participant } from '../models/Participant.js';
import { RemovedParticipant } from '../models/RemovedParticipant.js';
import { broadcaster } from '../sockets/broadcaster.js';
import { assertCompetitionOwner } from './competitionAccess.js';
import { recordAudit } from './auditService.js';
import { badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export async function withTransaction<T>(fn: (session?: mongoose.ClientSession) => Promise<T>): Promise<T> {
  let session: mongoose.ClientSession | undefined;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
  } catch {
    session = undefined;
  }

  if (!session) {
    return fn();
  }

  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (error: unknown) {
    await session.abortTransaction().catch(() => undefined);
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Transactions are not supported') || msg.includes('replica set')) {
      return fn();
    }
    throw error;
  } finally {
    await session.endSession().catch(() => undefined);
  }
}

export async function isParticipantRemoved(competitionId: string, studentId: string): Promise<boolean> {
  if (mongoose.connection.readyState !== 1) return false;
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) return false;
  return Boolean(await RemovedParticipant.exists({ competitionId, studentId }));
}

export async function restoreRemovedParticipantRecord(competitionId: string, studentId: string): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) return;
  await RemovedParticipant.deleteOne({ competitionId, studentId });
}

export async function deleteSingleParticipant(
  competitionId: string,
  studentId: string,
  hostId: string,
): Promise<{ deleted: boolean }> {
  const result = await deleteBulkParticipants(competitionId, [studentId], hostId);
  return { deleted: result.deletedCount > 0 };
}

export async function deleteBulkParticipants(
  competitionId: string,
  studentIds: string[],
  hostId: string,
): Promise<{ deletedCount: number }> {
  await assertCompetitionOwner(competitionId, hostId);
  const compId = new Types.ObjectId(competitionId);
  const targetObjectIds = studentIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
  if (!targetObjectIds.length) return { deletedCount: 0 };

  return withTransaction(async (session) => {
    // 1. Fetch current participant records and attempts for backup
    const [participants, attempts] = await Promise.all([
      Participant.find({ competitionId: compId, studentId: { $in: targetObjectIds } }).lean(),
      Attempt.find({ competitionId: compId, studentId: { $in: targetObjectIds } }).lean(),
    ]);

    if (!participants.length) {
      return { deletedCount: 0 };
    }

    const undoExpiresAt = new Date(Date.now() + 15_000); // 15-second undo window

    // 2. Upsert RemovedParticipant records with backupData
    const bulkOps = participants.map((p) => {
      const pAttempts = attempts.filter((a) => String(a.studentId) === String(p.studentId));
      return {
        updateOne: {
          filter: { competitionId: compId, studentId: p.studentId },
          update: {
            $set: {
              removedBy: new Types.ObjectId(hostId),
              removedAt: new Date(),
              undoExpiresAt,
              backupData: {
                participant: p,
                attempts: pAttempts,
              },
            },
          },
          upsert: true,
        },
      };
    });

    await RemovedParticipant.bulkWrite(bulkOps, { session });

    // 3. Delete participant and attempt records
    await Promise.all([
      Participant.deleteMany({ competitionId: compId, studentId: { $in: targetObjectIds } }, { session }),
      Attempt.deleteMany({ competitionId: compId, studentId: { $in: targetObjectIds } }, { session }),
    ]);

    // 4. Notify affected students & broadcast updated counts to host rooms
    const remainingCount = await Participant.countDocuments({ competitionId: compId });
    broadcaster().toHosts(competitionId, 'participant:joined', { competitionId, participantCount: remainingCount });

    for (const sid of studentIds) {
      broadcaster().toStudent(sid, 'participant:removed', {
        competitionId,
        message: 'Your access to this competition has been removed by the host.',
      });
      void broadcaster().kickFromCompetition(competitionId, sid);
    }

    // 5. Audit log
    await recordAudit({
      actorId: hostId,
      actorRole: 'host',
      action: 'participant.delete',
      competitionId,
      details: { count: participants.length, studentIds },
    });

    return { deletedCount: participants.length };
  });
}

export async function deleteAllParticipants(
  competitionId: string,
  hostId: string,
): Promise<{ deletedCount: number }> {
  await assertCompetitionOwner(competitionId, hostId);
  const compId = new Types.ObjectId(competitionId);
  const allParticipants = await Participant.find({ competitionId: compId }).select('studentId').lean();
  const allStudentIds = allParticipants.map((p) => String(p.studentId));
  if (!allStudentIds.length) return { deletedCount: 0 };
  return deleteBulkParticipants(competitionId, allStudentIds, hostId);
}

export async function undoDeleteParticipants(
  competitionId: string,
  hostId: string,
  studentIds?: string[],
): Promise<{ restoredCount: number }> {
  await assertCompetitionOwner(competitionId, hostId);
  const compId = new Types.ObjectId(competitionId);
  const now = new Date();

  const query: Record<string, unknown> = {
    competitionId: compId,
    removedBy: new Types.ObjectId(hostId),
    undoExpiresAt: { $gte: now },
  };
  if (studentIds && studentIds.length > 0) {
    query.studentId = { $in: studentIds.map((id) => new Types.ObjectId(id)) };
  }

  const candidates = await RemovedParticipant.find(query).lean();
  if (!candidates.length) {
    throw badRequest('No recently deleted participants found to undo (undo window may have expired).');
  }

  return withTransaction(async (session) => {
    let restoredCount = 0;
    const restoredIds: string[] = [];

    for (const item of candidates) {
      if (item.backupData?.participant) {
        try {
          const participantData = { ...item.backupData.participant };
          delete participantData._id;
          await Participant.findOneAndUpdate(
            { competitionId: compId, studentId: item.studentId },
            { $set: participantData },
            { upsert: true, session },
          );
          if (item.backupData.attempts?.length) {
            for (const att of item.backupData.attempts) {
              const attData = { ...att };
              delete attData._id;
              await Attempt.findOneAndUpdate(
                { competitionId: compId, questionId: attData.questionId, studentId: item.studentId },
                { $set: attData },
                { upsert: true, session },
              );
            }
          }
          restoredCount++;
          restoredIds.push(String(item.studentId));
        } catch (err) {
          logger.error('Failed to restore participant during undo', { studentId: item.studentId, error: err });
        }
      }
    }

    await RemovedParticipant.deleteMany(
      { competitionId: compId, studentId: { $in: restoredIds.map((id) => new Types.ObjectId(id)) } },
      { session },
    );

    const participantCount = await Participant.countDocuments({ competitionId: compId });
    broadcaster().toHosts(competitionId, 'participant:joined', { competitionId, participantCount });

    for (const sid of restoredIds) {
      broadcaster().toStudent(sid, 'participant:restored', { competitionId });
    }

    await recordAudit({
      actorId: hostId,
      actorRole: 'host',
      action: 'participant.undo_delete',
      competitionId,
      details: { count: restoredCount, studentIds: restoredIds },
    });

    return { restoredCount };
  });
}
