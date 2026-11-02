/**
 * One Durable Object per competition. Every request for that competition, from any edge location, reaches
 * this single instance, so it can keep the list of live connections and fan events out to all of them.
 *
 *   GET  /connect           open a Server-Sent Events stream (the Worker has already authenticated the user)
 *   POST /publish           send events to everyone, hosts, students, or one student
 *   GET  /presence          student IDs with an open stream right now
 *   POST /kick              tell removed students why, then close their streams
 *   POST /sessions-changed  re-arm the alarm for the next exam-session deadline
 *   POST /answered          debounce a leaderboard refresh for hosts
 *
 * The alarm (rule 8) fires when the earliest running exam session's timer runs out: it marks every due
 * session EXPIRED in the database, tells those students, refreshes the hosts' leaderboard and re-arms itself
 * for the next deadline. The database stays the source of truth; the alarm only makes it happen on time
 * even if the student has closed the tab.
 */
import { DurableObject } from 'cloudflare:workers';
import { createNeonDb, type Db } from '../db/client.js';
import type { Bindings } from '../env.js';
import { computeLeaderboard } from '../services/results.js';
import { expireDueSessions } from '../services/sessions.js';
import type { RoomMessage } from './client.js';

interface Client {
  id: string;
  userId: string;
  role: 'student' | 'host';
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;
const LEADERBOARD_DEBOUNCE_MS = 1_500;

function frame(event: string, data: unknown, id?: string): Uint8Array {
  return encoder.encode(`event: ${event}\nid: ${id ?? Date.now()}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class CompetitionRoom extends DurableObject<Bindings> {
  private clients = new Map<string, Client>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private leaderboardTimer: ReturnType<typeof setTimeout> | undefined;
  private competitionId: string | undefined;
  private dbInstance: Db | undefined;

  private get db(): Db {
    this.dbInstance ??= createNeonDb(this.env.DATABASE_URL);
    return this.dbInstance;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const competitionId = request.headers.get('x-competition-id');
    if (competitionId && competitionId !== this.competitionId) {
      this.competitionId = competitionId;
      await this.ctx.storage.put('competitionId', competitionId);
    }

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /connect':
        return this.openStream(request);
      case 'POST /publish':
        this.publish((await request.json()) as RoomMessage[]);
        return new Response(null, { status: 204 });
      case 'GET /presence':
        return Response.json({ studentIds: this.studentIds() });
      case 'POST /kick':
        this.kick(((await request.json()) as { studentIds: string[] }).studentIds);
        return new Response(null, { status: 204 });
      case 'POST /sessions-changed':
        await this.armAlarm();
        return new Response(null, { status: 204 });
      case 'POST /answered':
        this.scheduleLeaderboard();
        return new Response(null, { status: 204 });
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  private openStream(request: Request): Response {
    const userId = request.headers.get('x-user-id') ?? '';
    const role = request.headers.get('x-user-role') === 'host' ? 'host' : 'student';
    const hello = JSON.parse(decodeURIComponent(request.headers.get('x-hello') ?? '%7B%7D')) as unknown;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const client: Client = { id: crypto.randomUUID(), userId, role, writer: writable.getWriter() };
    this.clients.set(client.id, client);
    this.startHeartbeat();

    // Comment line first so proxies start streaming at once, then the hello event the frontend waits for.
    void client.writer.write(encoder.encode(': connected\n\n')).catch(() => this.drop(client.id));
    void client.writer.write(frame('connected', hello, '0')).catch(() => this.drop(client.id));
    if (role === 'student') this.broadcastConnectionCount();

    request.signal?.addEventListener('abort', () => this.drop(client.id));

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  private drop(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    client.writer.close().catch(() => undefined);
    if (client.role === 'student') this.broadcastConnectionCount();
    if (!this.clients.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private send(client: Client, event: string, data: unknown): void {
    client.writer.write(frame(event, data)).catch(() => this.drop(client.id));
  }

  private startHeartbeat(): void {
    // A ping every 15 s keeps proxies from closing idle streams and reveals clients that have gone away.
    this.heartbeat ??= setInterval(() => {
      for (const client of [...this.clients.values()]) this.send(client, 'ping', { timestamp: Date.now() });
    }, HEARTBEAT_MS);
  }

  private studentIds(): string[] {
    return [...new Set([...this.clients.values()].filter((c) => c.role === 'student').map((c) => c.userId))];
  }

  private broadcastConnectionCount(): void {
    const connected = this.studentIds().length;
    for (const client of this.clients.values()) if (client.role === 'host') this.send(client, 'participant:connection', { connected });
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  private publish(messages: RoomMessage[]): void {
    for (const message of messages) {
      for (const client of [...this.clients.values()]) {
        const match =
          message.target === 'all' ||
          (message.target === 'hosts' && client.role === 'host') ||
          (message.target === 'students' && client.role === 'student') ||
          (message.target === 'student' && client.role === 'student' && client.userId === message.studentId);
        if (match) this.send(client, message.event, message.payload);
      }
    }
  }

  private kick(studentIds: string[]): void {
    const targets = new Set(studentIds);
    for (const client of [...this.clients.values()]) {
      if (client.role !== 'student' || !targets.has(client.userId)) continue;
      client.writer
        .write(frame('participant:removed', { competitionId: this.competitionId, message: 'Your access to this competition has been removed by the host.' }))
        .catch(() => undefined)
        .finally(() => this.drop(client.id));
    }
  }

  // -------------------------------------------------------------------------
  // Leaderboard and session deadlines
  // -------------------------------------------------------------------------

  /** Coalesces bursts of answers into at most one leaderboard query per 1.5 s, and only when a host is watching. */
  private scheduleLeaderboard(): void {
    if (this.leaderboardTimer) return;
    this.leaderboardTimer = setTimeout(() => {
      this.leaderboardTimer = undefined;
      void this.pushLeaderboard();
    }, LEADERBOARD_DEBOUNCE_MS);
  }

  private async pushLeaderboard(): Promise<void> {
    const competitionId = await this.getCompetitionId();
    if (!competitionId || ![...this.clients.values()].some((c) => c.role === 'host')) return;
    try {
      const entries = await computeLeaderboard(this.db, competitionId);
      this.publish([{ target: 'hosts', event: 'leaderboard:updated', payload: { competitionId, entries, total: entries.length } }]);
    } catch (error) {
      console.error('Leaderboard refresh failed', competitionId, error);
    }
  }

  private async getCompetitionId(): Promise<string | undefined> {
    this.competitionId ??= await this.ctx.storage.get<string>('competitionId');
    return this.competitionId;
  }

  /** Sets the alarm for the earliest deadline among this competition's running exam sessions. */
  private async armAlarm(): Promise<void> {
    const competitionId = await this.getCompetitionId();
    if (!competitionId) return;
    const { expiredStudentIds, nextDeadline } = await expireDueSessions(this.db, competitionId);
    this.announceExpired(competitionId, expiredStudentIds);
    if (nextDeadline) await this.ctx.storage.setAlarm(nextDeadline.getTime() + 250);
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    await this.armAlarm();
  }

  private announceExpired(competitionId: string, studentIds: string[]): void {
    if (!studentIds.length) return;
    this.publish(
      studentIds.map((studentId) => ({ target: 'student' as const, studentId, event: 'session:expired', payload: { competitionId } })),
    );
    this.scheduleLeaderboard();
  }
}
