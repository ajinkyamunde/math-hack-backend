import { Types } from 'mongoose';
import { Attempt } from '../models/Attempt.js';
import { Competition, type CompetitionLean, type QueueItem } from '../models/Competition.js';
import { ExamSession } from '../models/ExamSession.js';
import { Participant } from '../models/Participant.js';
import { Question } from '../models/Question.js';
import { sseHub } from '../realtime/sseHub.js';
import type { OptionKey } from '../types/domain.js';
import { AppError, badRequest, notFound, isDuplicateKeyError } from '../utils/errors.js';
import { isParticipantRemoved } from './participantManagementService.js';

export interface PublicExamQuestion {
  id: string;
  questionText: string;
  options: string[];
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  points: number;
  timeLimitSeconds: number;
  order: number;
}

export function sanitizeQuestion(item: QueueItem, fallback?: { questionText: string; options: string[]; difficulty: string; points: number }): PublicExamQuestion {
  return {
    id: String(item.questionId),
    questionText: item.snapshot?.questionText ?? fallback?.questionText ?? '',
    options: item.snapshot?.options ?? fallback?.options ?? [],
    difficulty: (item.snapshot?.difficulty ?? fallback?.difficulty ?? 'EASY') as 'EASY' | 'MEDIUM' | 'HARD',
    points: item.snapshot?.points ?? fallback?.points ?? 10,
    timeLimitSeconds: item.snapshot?.timeLimitSeconds ?? 30,
    order: item.order,
  };
}

async function loadSanitizedQuestions(competition: CompetitionLean): Promise<PublicExamQuestion[]> {
  const missing = competition.queue.filter((q) => !q.snapshot);
  let fallbackMap = new Map<string, Record<string, unknown>>();
  if (missing.length > 0) {
    const ids = missing.map((q) => q.questionId);
    const docs = await Question.find({ _id: { $in: ids } }).lean();
    fallbackMap = new Map(docs.map((d) => [String(d._id), d]));
  }

  return competition.queue
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((item) => sanitizeQuestion(item, fallbackMap.get(String(item.questionId))));
}

export async function assertRegisteredParticipant(competitionId: string, studentId: string): Promise<void> {
  const removed = await isParticipantRemoved(competitionId, studentId);
  if (removed) {
    throw new AppError(403, 'PARTICIPANT_REMOVED', 'Your access to this competition has been removed by the host.');
  }

  const participant = await Participant.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  }).lean();

  if (!participant || participant.registrationStatus === 'REMOVED') {
    throw new AppError(403, 'NOT_REGISTERED', 'You are not registered for this competition.');
  }
}

export async function startTestSession(competitionId: string, studentId: string) {
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) {
    throw badRequest('Invalid competition or student ID.');
  }

  await assertRegisteredParticipant(competitionId, studentId);

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) throw notFound('Competition');

  const isLive = competition.status === 'RUNNING' || (competition.status as string) === 'ACTIVE';
  if (!isLive) {
    throw new AppError(400, 'COMPETITION_NOT_ACTIVE', 'Competition is not active yet. Please wait for the host to start.');
  }

  // Idempotency: return existing session if participant already started
  let session = await ExamSession.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  });

  const now = new Date();
  if (!session) {
    const durationSeconds = competition.durationSeconds || 1800;
    const expiresAt = new Date(now.getTime() + durationSeconds * 1000);

    try {
      session = await ExamSession.create({
        competitionId: new Types.ObjectId(competitionId),
        studentId: new Types.ObjectId(studentId),
        startedAt: now,
        expiresAt,
        status: 'ACTIVE',
        score: 0,
        answers: [],
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // Handled race condition: fetch the created session
        session = await ExamSession.findOne({
          competitionId: new Types.ObjectId(competitionId),
          studentId: new Types.ObjectId(studentId),
        });
      } else {
        throw err;
      }
    }
  }

  if (!session) {
    throw new AppError(500, 'SESSION_CREATION_FAILED', 'Failed to initialize exam session.');
  }

  // Update participant connection status
  await Participant.updateOne(
    { competitionId: new Types.ObjectId(competitionId), studentId: new Types.ObjectId(studentId) },
    { $set: { connectionStatus: 'ONLINE', lastSeenAt: now } },
  );

  const questions = await loadSanitizedQuestions(competition);
  const answersMap: Record<string, { selectedOption: string | null; submittedAt: string }> = {};
  for (const ans of session.answers) {
    answersMap[String(ans.questionId)] = {
      selectedOption: ans.selectedOption ?? null,
      submittedAt: ans.submittedAt.toISOString(),
    };
  }

  const remainingMs = Math.max(0, session.expiresAt.getTime() - now.getTime());

  return {
    session: {
      sessionId: String(session._id),
      competitionId,
      studentId,
      startedAt: session.startedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      durationSeconds: competition.durationSeconds,
      remainingMs,
      serverNow: now.toISOString(),
      status: session.status,
      score: session.score,
    },
    questions,
    answers: answersMap,
  };
}

export async function getMySession(competitionId: string, studentId: string) {
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) {
    throw badRequest('Invalid competition or student ID.');
  }

  await assertRegisteredParticipant(competitionId, studentId);

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) throw notFound('Competition');

  const session = await ExamSession.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  });

  const now = new Date();
  if (!session) {
    return {
      session: null,
      competitionStatus: competition.status,
      competitionName: competition.name,
      durationSeconds: competition.durationSeconds,
      isRegistered: true,
      serverNow: now.toISOString(),
    };
  }

  // Check if session has expired
  if (session.status === 'ACTIVE' && now.getTime() > session.expiresAt.getTime()) {
    session.status = 'EXPIRED';
    await session.save();
  }

  const questions = await loadSanitizedQuestions(competition);
  const answersMap: Record<string, { selectedOption: string | null; submittedAt: string }> = {};
  for (const ans of session.answers) {
    answersMap[String(ans.questionId)] = {
      selectedOption: ans.selectedOption ?? null,
      submittedAt: ans.submittedAt.toISOString(),
    };
  }

  const remainingMs = Math.max(0, session.expiresAt.getTime() - now.getTime());

  return {
    session: {
      sessionId: String(session._id),
      competitionId,
      studentId,
      startedAt: session.startedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      durationSeconds: competition.durationSeconds,
      remainingMs,
      serverNow: now.toISOString(),
      status: session.status,
      score: session.score,
    },
    competitionStatus: competition.status,
    competitionName: competition.name,
    questions,
    answers: answersMap,
  };
}

export async function submitSessionAnswer(
  competitionId: string,
  studentId: string,
  questionId: string,
  selectedOption: OptionKey | null,
) {
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId) || !Types.ObjectId.isValid(questionId)) {
    throw badRequest('Invalid parameter IDs.');
  }

  await assertRegisteredParticipant(competitionId, studentId);

  const session = await ExamSession.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  });

  if (!session) {
    throw new AppError(403, 'NO_ACTIVE_SESSION', 'Exam session has not been started.');
  }

  if (session.status !== 'ACTIVE') {
    throw new AppError(400, 'SESSION_NOT_ACTIVE', `Cannot submit answer to a ${session.status.toLowerCase()} session.`);
  }

  const now = new Date();
  const GRACE_PERIOD_MS = 5000;
  if (now.getTime() > session.expiresAt.getTime() + GRACE_PERIOD_MS) {
    session.status = 'EXPIRED';
    await session.save();
    throw new AppError(400, 'SESSION_EXPIRED', 'Your exam session has expired.');
  }

  // Prevent duplicate submissions for the same question
  const alreadyAnswered = session.answers.some((a) => String(a.questionId) === questionId);
  if (alreadyAnswered) {
    throw new AppError(409, 'ALREADY_SUBMITTED', 'You have already submitted an answer for this question.');
  }

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) throw notFound('Competition');

  const queueItem = competition.queue.find((q) => String(q.questionId) === questionId);
  if (!queueItem) {
    throw notFound('Question not found in this competition.');
  }

  let correctOption = queueItem.snapshot?.correctOption;
  let points = queueItem.snapshot?.points ?? 10;
  let difficulty = queueItem.snapshot?.difficulty ?? 'EASY';

  if (!correctOption) {
    const rawQuestion = await Question.findById(questionId).lean();
    if (rawQuestion) {
      correctOption = rawQuestion.correctOption;
      points = rawQuestion.points;
      difficulty = rawQuestion.difficulty;
    }
  }

  const isCorrect = selectedOption !== null && selectedOption === correctOption;
  const pointsAwarded = isCorrect ? points : 0;

  const answerRecord = {
    questionId: new Types.ObjectId(questionId),
    selectedOption,
    submittedAt: now,
    isCorrect,
    pointsAwarded,
  };

  const updatedSession = await ExamSession.findOneAndUpdate(
    {
      _id: session._id,
      status: 'ACTIVE',
      'answers.questionId': { $ne: new Types.ObjectId(questionId) },
    },
    {
      $push: { answers: answerRecord },
      $inc: { score: pointsAwarded },
    },
    { new: true },
  );

  if (!updatedSession) {
    throw new AppError(409, 'ALREADY_SUBMITTED', 'Answer submission conflict: already submitted.');
  }

  // Update Attempt model for analytics & exports
  const responseTimeMs = Math.max(0, now.getTime() - session.startedAt.getTime());
  await Attempt.findOneAndUpdate(
    {
      competitionId: new Types.ObjectId(competitionId),
      questionId: new Types.ObjectId(questionId),
      studentId: new Types.ObjectId(studentId),
    },
    {
      $set: {
        difficulty,
        selectedOption,
        isCorrect,
        responseTimeMs,
        pointsAwarded,
        submittedAt: now,
        timedOut: false,
      },
    },
    { upsert: true, new: true },
  );

  // Update participant finalScore
  await Participant.updateOne(
    { competitionId: new Types.ObjectId(competitionId), studentId: new Types.ObjectId(studentId) },
    { $set: { finalScore: updatedSession.score } },
  );

  // Notify host dashboard
  const answeredTotal = await Attempt.countDocuments({
    competitionId: new Types.ObjectId(competitionId),
    questionId: new Types.ObjectId(questionId),
  });
  sseHub.toHosts(competitionId, 'question:answer-count', { questionId, answered: answeredTotal });

  return {
    ok: true,
    questionId,
    selectedOption,
    submittedAt: now.toISOString(),
    score: updatedSession.score,
  };
}

export async function completeSession(competitionId: string, studentId: string) {
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) {
    throw badRequest('Invalid competition or student ID.');
  }

  await assertRegisteredParticipant(competitionId, studentId);

  const session = await ExamSession.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  });

  if (!session) {
    throw notFound('Exam session');
  }

  const now = new Date();
  if (session.status !== 'COMPLETED') {
    session.status = 'COMPLETED';
    session.submittedAt = now;
    await session.save();
  }

  await Participant.updateOne(
    { competitionId: new Types.ObjectId(competitionId), studentId: new Types.ObjectId(studentId) },
    { $set: { completedAt: now, finalScore: session.score } },
  );

  return {
    ok: true,
    status: 'COMPLETED',
    score: session.score,
    submittedAt: now.toISOString(),
  };
}

export async function getSessionQuestions(competitionId: string, studentId: string) {
  if (!Types.ObjectId.isValid(competitionId) || !Types.ObjectId.isValid(studentId)) {
    throw badRequest('Invalid competition or student ID.');
  }

  await assertRegisteredParticipant(competitionId, studentId);

  const session = await ExamSession.findOne({
    competitionId: new Types.ObjectId(competitionId),
    studentId: new Types.ObjectId(studentId),
  });

  if (!session) {
    throw new AppError(403, 'NO_ACTIVE_SESSION', 'Questions are only accessible after starting your exam session.');
  }

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) throw notFound('Competition');

  return loadSanitizedQuestions(competition);
}
