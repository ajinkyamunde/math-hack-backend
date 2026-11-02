import type { Role } from '../domain.js';

export type RoomTarget = 'all' | 'hosts' | 'students' | 'student';

export interface RoomMessage {
  target: RoomTarget;
  /** Required when target is "student". */
  studentId?: string;
  event: string;
  payload: unknown;
}

/**
 * What the API needs from the live layer. In the Worker this talks to the competition's Durable Object;
 * tests swap in an in-memory recorder.
 */
export interface Realtime {
  /** Sends events to connected clients. Fire-and-forget: a failed push never fails the request. */
  publish(competitionId: string, messages: RoomMessage[]): void;
  /** Student IDs with at least one open live connection right now. */
  presence(competitionId: string): Promise<string[]>;
  /** Opens a Server-Sent Events stream for this user. */
  connect(competitionId: string, user: { id: string; role: Role }, hello: unknown, request: Request): Promise<Response>;
  /** Closes a removed student's streams after telling them why. */
  kick(competitionId: string, studentIds: string[]): void;
  /** Re-arms the alarm that finalises exam sessions when their timers run out. */
  sessionsChanged(competitionId: string): void;
  /** An answer was recorded; hosts get a debounced leaderboard refresh. */
  answered(competitionId: string): void;
}

/** Realtime backed by one CompetitionRoom Durable Object per competition. */
export function durableObjectRealtime(namespace: DurableObjectNamespace, waitUntil: (promise: Promise<unknown>) => void): Realtime {
  const stub = (competitionId: string) => namespace.get(namespace.idFromName(competitionId));
  const call = (competitionId: string, path: string, init: RequestInit = {}) =>
    stub(competitionId).fetch(`https://room${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-competition-id': competitionId, ...(init.headers as Record<string, string> | undefined) },
    });
  const background = (promise: Promise<Response>) =>
    waitUntil(
      promise.then(
        (res) => res.body?.cancel(),
        (error: unknown) => console.error('Durable Object call failed', error),
      ),
    );

  return {
    publish(competitionId, messages) {
      if (messages.length) background(call(competitionId, '/publish', { method: 'POST', body: JSON.stringify(messages) }));
    },
    async presence(competitionId) {
      try {
        const res = await call(competitionId, '/presence');
        return ((await res.json()) as { studentIds: string[] }).studentIds;
      } catch (error) {
        console.error('Presence lookup failed', error);
        return [];
      }
    },
    connect(competitionId, user, hello, request) {
      return stub(competitionId).fetch('https://room/connect', {
        signal: request.signal,
        headers: {
          'x-competition-id': competitionId,
          'x-user-id': user.id,
          'x-user-role': user.role,
          'x-hello': encodeURIComponent(JSON.stringify(hello)),
        },
      });
    },
    kick(competitionId, studentIds) {
      if (studentIds.length) background(call(competitionId, '/kick', { method: 'POST', body: JSON.stringify({ studentIds }) }));
    },
    sessionsChanged(competitionId) {
      background(call(competitionId, '/sessions-changed', { method: 'POST' }));
    },
    answered(competitionId) {
      background(call(competitionId, '/answered', { method: 'POST' }));
    },
  };
}
