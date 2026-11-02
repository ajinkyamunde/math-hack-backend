import { Schema, model, type InferSchemaType } from 'mongoose';

const removedParticipantSchema = new Schema(
  {
    competitionId: { type: Schema.Types.ObjectId, ref: 'Competition', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    removedBy: { type: Schema.Types.ObjectId, ref: 'Host', required: true },
    removedAt: { type: Date, default: () => new Date() },
    undoExpiresAt: { type: Date, required: true },
    backupData: {
      participant: { type: Schema.Types.Mixed },
      attempts: { type: [Schema.Types.Mixed], default: [] },
    },
  },
  { timestamps: true },
);

removedParticipantSchema.index({ competitionId: 1, studentId: 1 }, { unique: true });
removedParticipantSchema.index({ competitionId: 1, removedAt: -1 });
removedParticipantSchema.index({ undoExpiresAt: 1 });

export type RemovedParticipantAttrs = InferSchemaType<typeof removedParticipantSchema>;
export const RemovedParticipant = model('RemovedParticipant', removedParticipantSchema);
