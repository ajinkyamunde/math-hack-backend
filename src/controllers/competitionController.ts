import type { Request, Response } from 'express';
import * as competitions from '../services/competitionService.js';
import {
  completeSession,
  getMySession,
  getSessionQuestions,
  startTestSession,
} from '../services/examSessionService.js';
import { submitAnswer } from '../services/scoringService.js';
import type { OptionKey } from '../types/domain.js';
import { Competition, type CompetitionLean } from '../models/Competition.js';
import { notFound } from '../utils/errors.js';

const id = (req: Request): string => String(req.params.id);
const actor = (req: Request): string => req.auth!.id;

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json({ competition: await competitions.createCompetition(req.body, actor(req)) });
}

export async function list(req: Request, res: Response): Promise<void> {
  const auth = req.auth!;
  const query = req.query as unknown as { page: number; pageSize: number; status?: string };
  res.json(await competitions.listCompetitions(auth.role, query, auth.role === 'student' ? auth.id : undefined));
}

/** Hosts get the full control view; students get the sanitized live state (also the HTTP fallback for sockets). */
export async function get(req: Request, res: Response): Promise<void> {
  const auth = req.auth!;
  const competition = auth.role === 'host' ? await competitions.hostState(id(req)) : await competitions.studentState(id(req), auth.id);
  res.json({ competition });
}

export async function update(req: Request, res: Response): Promise<void> {
  res.json({ competition: await competitions.updateCompetition(id(req), req.body, actor(req)) });
}

export async function setQueue(req: Request, res: Response): Promise<void> {
  res.json({ competition: await competitions.setQueue(id(req), (req.body as { questionIds: string[] }).questionIds, actor(req)) });
}

export async function setDirectQuestions(req: Request, res: Response): Promise<void> {
  const body = req.body as { questions: Parameters<typeof competitions.setDirectQuestions>[1] };
  res.json({ competition: await competitions.setDirectQuestions(id(req), body.questions, actor(req)) });
}

export async function join(req: Request, res: Response): Promise<void> {
  res.json({ competition: await competitions.joinCompetition(id(req), actor(req)) });
}

export async function submit(req: Request, res: Response): Promise<void> {
  const body = req.body as { questionId: string; selectedOption: OptionKey };
  const result = await submitAnswer({ competitionId: id(req), studentId: actor(req), ...body });
  res.status(result.alreadySubmitted ? 200 : 201).json({ submission: result });
}

export async function startTest(req: Request, res: Response): Promise<void> {
  const data = await startTestSession(id(req), actor(req));
  res.json(data);
}

export async function mySession(req: Request, res: Response): Promise<void> {
  const data = await getMySession(id(req), actor(req));
  res.json(data);
}

export async function questions(req: Request, res: Response): Promise<void> {
  const qs = await getSessionQuestions(id(req), actor(req));
  res.json({ questions: qs });
}

export async function complete(req: Request, res: Response): Promise<void> {
  const result = await completeSession(id(req), actor(req));
  res.json(result);
}

export async function status(req: Request, res: Response): Promise<void> {
  const competition = await Competition.findById(id(req)).lean<CompetitionLean>();
  if (!competition) throw notFound('Competition');
  const now = new Date();
  const currentStatus = competition.status === 'RUNNING' ? 'ACTIVE' : competition.status;
  const registrationStatus = competition.status === 'WAITING' ? 'OPEN' : competition.status === 'DRAFT' ? 'NOT_OPEN' : 'CLOSED';
  res.json({
    competitionId: id(req),
    name: competition.name,
    status: currentStatus,
    registrationStatus,
    startedAt: competition.startedAt?.toISOString() ?? null,
    durationSeconds: competition.durationSeconds,
    serverNow: now.toISOString(),
  });
}

const command =
  (action: (competitionId: string, hostId: string, questionId?: string) => Promise<unknown>) =>
  async (req: Request, res: Response): Promise<void> => {
    const questionId = (req.body as { questionId?: string } | undefined)?.questionId;
    res.json({ competition: await action(id(req), actor(req), questionId) });
  };

export const open = command(competitions.openRegistration);
export const start = command(competitions.startCompetition);
export const pause = command(competitions.pauseCompetition);
export const resume = command(competitions.resumeCompetition);
export const publish = command(competitions.publishQuestion);
export const releaseAll = command(competitions.releaseAllQuestions);
export const skip = command(competitions.skipQuestion);
export const end = command(competitions.endCompetition);
export const cancel = command(competitions.cancelCompetition);
