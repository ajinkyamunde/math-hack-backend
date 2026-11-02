import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { Types } from 'mongoose';
import { Competition, type CompetitionLean } from '../models/Competition.js';
import { loadActiveAccount, SESSION_COOKIE, verifySessionToken } from '../services/authService.js';
import { assertCompetitionOwner } from '../services/competitionAccess.js';
import * as competitions from '../services/competitionService.js';
import {
  completeSession,
  getMySession,
  getSessionQuestions,
  startTestSession,
  submitSessionAnswer,
} from '../services/examSessionService.js';
import { isParticipantRemoved } from '../services/participantManagementService.js';
import { sseHub, type SSEClient } from './sseHub.js';
import type { AuthUser, OptionKey } from '../types/domain.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

type Variables = {
  auth: AuthUser;
};

export const honoApp = new Hono<{ Variables: Variables }>();

// Global error handler for Hono: accurately maps AppError to HTTP status codes
honoApp.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as ContentfulStatusCode);
  }
  logger.error('Unhandled Hono error', { error: err });
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } }, 500);
});

// Authentication middleware for Hono routes
honoApp.use('*', async (c, next) => {
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const headerToken = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const queryToken = c.req.query('token');
  const token = cookieToken || headerToken || queryToken;

  if (!token) {
    if (c.req.path.endsWith('/health')) {
      return next();
    }
    return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, 401);
  }

  try {
    const session = verifySessionToken(token);
    await loadActiveAccount(session);
    c.set('auth', session);
    await next();
  } catch (error) {
    if (error instanceof AppError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
    }
    return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired session.' } }, 401);
  }
});

// Helper for host authorization
async function requireHostOwner(c: Context, competitionId: string): Promise<AuthUser> {
  const user = c.get('auth') as AuthUser;
  if (!user || user.role !== 'host') {
    throw new AppError(403, 'FORBIDDEN', 'Host access required.');
  }
  await assertCompetitionOwner(competitionId, user.id);
  return user;
}

// Helper for student role
function requireStudent(c: Context): AuthUser {
  const user = c.get('auth') as AuthUser;
  if (!user || user.role !== 'student') {
    throw new AppError(403, 'FORBIDDEN', 'Student access required.');
  }
  return user;
}

// ---------------------------------------------------------------------------
// Competition Realtime & Host Start Routes
// ---------------------------------------------------------------------------

// Open registration (idempotent)
honoApp.post('/competitions/:id/open-registration', async (c) => {
  const competitionId = c.req.param('id');
  const user = await requireHostOwner(c, competitionId);
  const state = await competitions.openRegistration(competitionId, user.id);
  sseHub.broadcast(competitionId, 'competition:state', state);
  return c.json({ ok: true, status: state.status, competitionId });
});

honoApp.post('/competitions/:id/open', async (c) => {
  const competitionId = c.req.param('id');
  const user = await requireHostOwner(c, competitionId);
  const state = await competitions.openRegistration(competitionId, user.id);
  sseHub.broadcast(competitionId, 'competition:state', state);
  return c.json({ ok: true, status: state.status, competitionId });
});

// Host start competition (idempotent / lifecycle validated)
honoApp.post('/competitions/:id/start', async (c) => {
  const competitionId = c.req.param('id');
  const user = await requireHostOwner(c, competitionId);

  const state = await competitions.startCompetition(competitionId, user.id);

  // Emit SSE notification to all registered participants
  sseHub.broadcast(competitionId, 'competition:started', {
    competitionId,
    status: 'ACTIVE',
    startedAt: state.startedAt,
    durationSeconds: state.durationSeconds,
  });

  return c.json({
    ...state,
    competition: state,
    ok: true,
    status: 'ACTIVE',
    startedAt: state.startedAt,
    durationSeconds: state.durationSeconds,
  });
});

// Get competition status
honoApp.get('/competitions/:id/status', async (c) => {
  const competitionId = c.req.param('id');
  if (!Types.ObjectId.isValid(competitionId)) {
    return c.json({ error: { code: 'INVALID_ID', message: 'Invalid competition ID.' } }, 400);
  }

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Competition not found.' } }, 404);
  }

  const now = new Date();
  const status = competition.status === 'RUNNING' ? 'ACTIVE' : competition.status;
  const registrationStatus = competition.status === 'WAITING' ? 'OPEN' : competition.status === 'DRAFT' ? 'NOT_OPEN' : 'CLOSED';

  return c.json({
    competitionId,
    name: competition.name,
    status,
    registrationStatus,
    startedAt: competition.startedAt?.toISOString() ?? null,
    durationSeconds: competition.durationSeconds,
    serverNow: now.toISOString(),
  });
});

// SSE Participant & Host event subscription
honoApp.get('/competitions/:id/events', async (c) => {
  const competitionId = c.req.param('id');
  const user = c.get('auth');

  if (!Types.ObjectId.isValid(competitionId)) {
    return c.text('Invalid competition ID', 400);
  }

  const competition = await Competition.findById(competitionId).lean<CompetitionLean>();
  if (!competition) {
    return c.text('Competition not found', 404);
  }

  if (user.role === 'student') {
    const removed = await isParticipantRemoved(competitionId, user.id);
    if (removed) {
      return c.text('Access removed by host', 403);
    }
  } else if (user.role === 'host') {
    await assertCompetitionOwner(competitionId, user.id);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');

  return streamSSE(c, async (stream) => {
    const clientId = `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();

    const client: SSEClient = {
      id: clientId,
      userId: user.id,
      role: user.role,
      write: async (event: string, data: unknown, id?: string) => {
        try {
          await stream.writeSSE({
            event,
            data: JSON.stringify(data),
            id: id ?? String(Date.now()),
          });
        } catch (err) {
          logger.debug('Failed to write SSE to client', { clientId, error: err });
        }
      },
      close: () => {
        try {
          stream.close();
        } catch {
          // ignore
        }
      },
    };

    const unsubscribe = sseHub.subscribe(competitionId, client);

    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({
        competitionId,
        status: competition.status === 'RUNNING' ? 'ACTIVE' : competition.status,
        serverNow: now.toISOString(),
        role: user.role,
      }),
      id: '0',
    });

    if (user.role === 'student') {
      const connectedCount = sseHub.connectedStudentIds(competitionId).length;
      sseHub.toHosts(competitionId, 'participant:connection', { connected: connectedCount });
    }

    stream.onAbort(() => {
      unsubscribe();
      if (user.role === 'student') {
        const connectedCount = sseHub.connectedStudentIds(competitionId).length;
        sseHub.toHosts(competitionId, 'participant:connection', { connected: connectedCount });
      }
    });

    while (true) {
      await stream.sleep(60000);
    }
  });
});

// ---------------------------------------------------------------------------
// Individual Participant Exam Session & Timers
// ---------------------------------------------------------------------------

// Individual start test
honoApp.post('/competitions/:id/start-test', async (c) => {
  const competitionId = c.req.param('id');
  const user = requireStudent(c);
  const data = await startTestSession(competitionId, user.id);
  return c.json(data);
});

// Get individual exam session & restore timer
honoApp.get('/competitions/:id/my-session', async (c) => {
  const competitionId = c.req.param('id');
  const user = requireStudent(c);
  const data = await getMySession(competitionId, user.id);
  return c.json(data);
});

// Get questions (only allowed after individual session start)
honoApp.get('/competitions/:id/questions', async (c) => {
  const competitionId = c.req.param('id');
  const user = requireStudent(c);
  const questions = await getSessionQuestions(competitionId, user.id);
  return c.json({ questions });
});

// Submit answer for a question
honoApp.post('/competitions/:id/submit', async (c) => {
  const competitionId = c.req.param('id');
  const user = requireStudent(c);

  let body: { questionId?: string; selectedOption?: OptionKey | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request body.' } }, 400);
  }

  if (!body.questionId) {
    return c.json({ error: { code: 'MISSING_QUESTION_ID', message: 'Question ID is required.' } }, 400);
  }

  const result = await submitSessionAnswer(
    competitionId,
    user.id,
    body.questionId,
    body.selectedOption ?? null,
  );
  return c.json(result);
});

// Complete individual exam session
honoApp.post('/competitions/:id/complete', async (c) => {
  const competitionId = c.req.param('id');
  const user = requireStudent(c);
  const result = await completeSession(competitionId, user.id);
  return c.json(result);
});
