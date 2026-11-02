import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const EXAM_SESSION_STATUSES = ['ACTIVE', 'SUBMITTED', 'EXPIRED', 'COMPLETED'] as const;
export type ExamSessionStatus = (typeof EXAM_SESSION_STATUSES)[number];

const sessionAnswerSchema = new Schema(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'Question', required: true },
    selectedOption: { type: String, enum: ['A', 'B', 'C', 'D', null], default: null },
    submittedAt: { type: Date, required: true },
    isCorrect: { type: Boolean, required: true },
    pointsAwarded: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const examSessionSchema = new Schema(
  {
    competitionId: { type: Schema.Types.ObjectId, ref: 'Competition', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: EXAM_SESSION_STATUSES, default: 'ACTIVE' },
    submittedAt: { type: Date },
    score: { type: Number, default: 0, min: 0 },
    answers: { type: [sessionAnswerSchema], default: [] },
  },
  { timestamps: true },
);

// Concurrency-safe unique compound index: exactly one session per participant per competition.
examSessionSchema.index({ competitionId: 1, studentId: 1 }, { unique: true });
examSessionSchema.index({ competitionId: 1, status: 1 });
examSessionSchema.index({ expiresAt: 1 });

export type ExamSessionAttrs = InferSchemaType<typeof examSessionSchema>;
export type ExamSessionDocument = ExamSessionAttrs & { _id: Types.ObjectId };
export const ExamSession = model('ExamSession', examSessionSchema);
