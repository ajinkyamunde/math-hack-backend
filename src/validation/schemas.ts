/**
 * Request schemas, carried over from the original backend so the frontend's validation messages and
 * field names stay the same. Only the id check changed (no Mongoose).
 */
import { z } from 'zod';
import {
  ACADEMIC_YEARS,
  DEFAULT_COMPETITION_SECONDS,
  DIFFICULTIES,
  DIFFICULTY_RULES,
  MAX_COMPETITION_SECONDS,
  MAX_POINTS,
  MIN_COMPETITION_SECONDS,
  OPTION_KEYS,
  PROGRESSION_MODES,
  QUESTION_STATUSES,
} from '../domain.js';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid identifier.');
export const idParams = z.object({ id: objectId });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value), 'Password must include upper-case, lower-case and a number.');

/** Participant passwords set by a host: exactly 4 letters or digits, nothing else (no spaces or symbols). */
export const participantPasswordSchema = z
  .string({ required_error: 'Enter a password.' })
  .regex(/^[A-Za-z0-9]{4}$/, 'Password must be exactly 4 letters or numbers (A–Z, a–z, 0–9), with no spaces or symbols.');

export const prnSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toUpperCase())
  .pipe(
    z
      .string()
      .min(6, 'PRN must be 6–20 letters or digits.')
      .max(20, 'PRN must be 6–20 letters or digits.')
      .regex(/^[A-Z0-9]+$/, 'PRN may contain only letters and digits.'),
  );

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').max(100),
    prn: prnSchema,
    email: z.string().trim().email('Enter a valid email address.').max(254),
    department: z.string().trim().min(2, 'Enter your department.').max(100),
    academicYear: z.enum(ACADEMIC_YEARS, { errorMap: () => ({ message: 'Choose your academic year.' }) }),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match.' });

export const loginSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('student'),
    identifier: z.string().trim().min(1, 'Enter your PRN or email.').max(254),
    password: z.string().min(1, 'Enter your password.').max(128),
  }),
  z.object({
    role: z.literal('host'),
    email: z.string().trim().email('Enter a valid email address.').max(254),
    password: z.string().min(1, 'Enter your password.').max(128),
  }),
]);

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const optionText = z.string().trim().min(1, 'Every option needs text.').max(500, 'Options must be at most 500 characters.');

/** Shared by manual creation and spreadsheet import, so both paths enforce identical rules. */
export const questionInputSchema = z
  .object({
    questionText: z.string().trim().min(3, 'Question text is required.').max(2000, 'Question text must be at most 2000 characters.'),
    options: z.array(optionText).length(4, 'A question needs exactly four options (A, B, C, D).'),
    correctOption: z.enum(OPTION_KEYS, { errorMap: () => ({ message: 'Correct answer must be A, B, C or D.' }) }),
    difficulty: z.enum(DIFFICULTIES, { errorMap: () => ({ message: 'Difficulty must be EASY, MEDIUM or HARD.' }) }),
    timeLimitSeconds: z.coerce.number().int('Time limit must be a whole number of seconds.').optional(),
    points: z.coerce.number().int('Points must be a whole number.').min(1, 'Points must be positive.').max(MAX_POINTS).optional(),
    topic: z.string().trim().max(100).optional().default(''),
    explanation: z.string().trim().max(2000).optional().default(''),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().default([]),
    status: z.enum(QUESTION_STATUSES).optional().default('DRAFT'),
  })
  .superRefine((data, ctx) => {
    const rule = DIFFICULTY_RULES[data.difficulty];
    if (data.timeLimitSeconds !== undefined && (data.timeLimitSeconds < rule.minSeconds || data.timeLimitSeconds > rule.maxSeconds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeLimitSeconds'],
        message: `${data.difficulty} questions need a time limit between ${rule.minSeconds} and ${rule.maxSeconds} seconds.`,
      });
    }
    const normalized = data.options.map((option) => option.trim().toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Options must all be different.' });
    }
  })
  .transform((data) => ({
    ...data,
    timeLimitSeconds: data.timeLimitSeconds ?? DIFFICULTY_RULES[data.difficulty].defaultSeconds,
    points: data.points ?? DIFFICULTY_RULES[data.difficulty].defaultPoints,
  }));

export type QuestionInput = z.output<typeof questionInputSchema>;

export const questionListQuerySchema = pagination.extend({
  search: z.string().trim().max(200).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  topic: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest', 'difficulty']).default('newest'),
});
export type QuestionListQuery = z.output<typeof questionListQuerySchema>;

export const importConfirmSchema = z.object({
  batchId: objectId,
  includeDuplicates: z.boolean().optional().default(false),
  status: z.enum(QUESTION_STATUSES).optional().default('ACTIVE'),
});

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

const pointsValue = z.coerce.number().int().min(0).max(MAX_POINTS);

export const directQuestionInputSchema = z.object({
  id: z.string().optional(),
  questionText: z.string().trim().min(3, 'Question text must be at least 3 characters.').max(2000),
  options: z.array(z.string().trim().min(1, 'Option cannot be empty.').max(500)).length(4, 'Exactly four options are required.'),
  correctOption: z.enum(OPTION_KEYS),
  difficulty: z.enum(DIFFICULTIES),
  points: pointsValue.optional(),
});
export type DirectQuestionInput = z.output<typeof directQuestionInputSchema>;

export const setDirectQuestionsSchema = z.object({
  questions: z.array(directQuestionInputSchema).min(1, 'At least one question is required.').max(50, 'A maximum of 50 questions can be entered.'),
});

export const competitionSettingsSchema = z.object({
  revealAnswers: z.boolean().optional(),
  showLeaderboardToStudents: z.boolean().optional(),
  completeWhenQueueEmpty: z.boolean().optional(),
  pointsOverride: z.object({ EASY: pointsValue.optional(), MEDIUM: pointsValue.optional(), HARD: pointsValue.optional() }).optional(),
});

export const createCompetitionSchema = z.object({
  name: z.string().trim().min(3, 'Name must be at least 3 characters.').max(120),
  description: z.string().trim().max(1000).optional().default(''),
  durationSeconds: z.coerce
    .number()
    .int()
    .min(MIN_COMPETITION_SECONDS, `Duration must be at least ${MIN_COMPETITION_SECONDS / 60} minute.`)
    .max(MAX_COMPETITION_SECONDS, `Duration must be at most ${MAX_COMPETITION_SECONDS / 3600} hours.`)
    .default(DEFAULT_COMPETITION_SECONDS),
  questionProgressionMode: z.enum(PROGRESSION_MODES).default('AUTOMATIC'),
  settings: competitionSettingsSchema.optional().default({}),
  questionIds: z.array(objectId).max(500).optional().default([]),
  questions: z.array(directQuestionInputSchema).max(50).optional(),
});
export type CreateCompetitionInput = z.output<typeof createCompetitionSchema>;

export const updateCompetitionSchema = createCompetitionSchema
  .omit({ questionIds: true, questions: true })
  .partial()
  .extend({ settings: competitionSettingsSchema.optional() });
export type UpdateCompetitionInput = z.output<typeof updateCompetitionSchema>;

export const setQueueSchema = z.object({
  questionIds: z
    .array(objectId)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'A question can appear only once in the queue.'),
});

export const submitAnswerSchema = z.object({
  questionId: objectId,
  selectedOption: z.enum(OPTION_KEYS, { errorMap: () => ({ message: 'Choose option A, B, C or D.' }) }).nullable().optional(),
});

export const competitionListQuerySchema = pagination.extend({
  status: z.enum(['DRAFT', 'WAITING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
});

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

export const PARTICIPANT_STATUSES = ['REGISTERED', 'JOINED', 'PLAYING', 'DISCONNECTED', 'COMPLETED', 'CANCELLED'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const optionalText = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((value) => value || undefined);

/** Filters shared by the participant list and its Excel export, so the export matches what the host sees. */
export const participantQuerySchema = z.object({
  search: optionalText,
  status: z.enum(PARTICIPANT_STATUSES).optional(),
  department: optionalText,
  academicYear: z.enum(ACADEMIC_YEARS).optional(),
  includeRegistered: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  tz: z
    .string()
    .max(64)
    .optional()
    .refine((value) => value === undefined || isTimeZone(value), 'Unknown time zone.'),
});
export type ParticipantQuery = z.output<typeof participantQuerySchema>;

export const createParticipantSchema = z.object({
  name: z.string().trim().min(2, "Enter the participant's full name.").max(100),
  email: z.string().trim().email('Enter a valid email address.').max(254),
  prn: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), prnSchema.optional()),
  department: z.string().trim().min(2, 'Enter a department or branch.').max(100),
  academicYear: z.enum(ACADEMIC_YEARS, { errorMap: () => ({ message: 'Choose a year of study.' }) }),
  competitionId: z.preprocess((value) => (value === '' || value === null ? undefined : value), objectId.optional()),
  password: participantPasswordSchema,
});
export type CreateParticipantInput = z.output<typeof createParticipantSchema>;

export const resetParticipantPasswordSchema = z.object({ password: participantPasswordSchema });
export const deleteBulkParticipantsSchema = z.object({ studentIds: z.array(objectId).min(1, 'Select at least one participant to delete.') });
export const undoDeleteParticipantsSchema = z.object({ studentIds: z.array(objectId).optional() });
export const participantParams = z.object({ id: objectId, studentId: objectId });
