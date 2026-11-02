import { createClient } from 'redis';
import { getEnv } from '../config/environment.js';
import { logger } from '../utils/logger.js';

export interface SSEClient {
  id: string;
  userId: string;
  role: 'student' | 'host';
  write: (event: string, data: unknown, id?: string) => Promise<void> | void;
  close: () => void;
}

class SSEHub {
  private competitionRooms = new Map<string, Map<string, SSEClient>>();
  private userIndex = new Map<string, Set<{ competitionId: string; clientId: string }>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private redisPub: ReturnType<typeof createClient> | null = null;
  private redisSub: ReturnType<typeof createClient> | null = null;
  private isRedisReady = false;

  constructor() {
    this.startHeartbeat();
  }

  async initRedis(): Promise<void> {
    const redisUrl = getEnv().REDIS_URL;
    if (!redisUrl) return;

    try {
      this.redisPub = createClient({ url: redisUrl });
      this.redisSub = this.redisPub.duplicate();
      await Promise.all([this.redisPub.connect(), this.redisSub.connect()]);

      await this.redisSub.pSubscribe('mh:events:*', (message, channel) => {
        try {
          const competitionId = channel.replace('mh:events:', '');
          const parsed = JSON.parse(message) as { target?: 'all' | 'hosts' | 'student'; studentId?: string; event: string; payload: unknown };
          if (parsed.target === 'hosts') {
            this.localToHosts(competitionId, parsed.event, parsed.payload);
          } else if (parsed.target === 'student' && parsed.studentId) {
            this.localToStudent(parsed.studentId, parsed.event, parsed.payload);
          } else {
            this.localBroadcast(competitionId, parsed.event, parsed.payload);
          }
        } catch (err) {
          logger.warn('Failed to process Redis SSE broadcast', { error: err });
        }
      });

      this.isRedisReady = true;
      logger.info('SSEHub Redis pub/sub enabled');
    } catch (err) {
      logger.warn('SSEHub Redis connection failed, falling back to in-memory', { error: err });
      this.isRedisReady = false;
    }
  }

  subscribe(competitionId: string, client: SSEClient): () => void {
    let room = this.competitionRooms.get(competitionId);
    if (!room) {
      room = new Map();
      this.competitionRooms.set(competitionId, room);
    }
    room.set(client.id, client);

    let userEntries = this.userIndex.get(client.userId);
    if (!userEntries) {
      userEntries = new Set();
      this.userIndex.set(client.userId, userEntries);
    }
    userEntries.add({ competitionId, clientId: client.id });

    logger.debug('SSE client subscribed', { competitionId, clientId: client.id, role: client.role, userId: client.userId });

    return () => this.unsubscribe(competitionId, client.id);
  }

  unsubscribe(competitionId: string, clientId: string): void {
    const room = this.competitionRooms.get(competitionId);
    if (!room) return;
    const client = room.get(clientId);
    if (!client) return;

    room.delete(clientId);
    if (room.size === 0) {
      this.competitionRooms.delete(competitionId);
    }

    const userEntries = this.userIndex.get(client.userId);
    if (userEntries) {
      for (const entry of [...userEntries]) {
        if (entry.competitionId === competitionId && entry.clientId === clientId) {
          userEntries.delete(entry);
        }
      }
      if (userEntries.size === 0) {
        this.userIndex.delete(client.userId);
      }
    }

    logger.debug('SSE client unsubscribed', { competitionId, clientId });
  }

  broadcast(competitionId: string, event: string, payload: unknown): void {
    if (this.isRedisReady && this.redisPub) {
      this.redisPub.publish(`mh:events:${competitionId}`, JSON.stringify({ target: 'all', event, payload })).catch(() => undefined);
    }
    this.localBroadcast(competitionId, event, payload);
  }

  toHosts(competitionId: string, event: string, payload: unknown): void {
    if (this.isRedisReady && this.redisPub) {
      this.redisPub.publish(`mh:events:${competitionId}`, JSON.stringify({ target: 'hosts', event, payload })).catch(() => undefined);
    }
    this.localToHosts(competitionId, event, payload);
  }

  toStudent(studentId: string, event: string, payload: unknown): void {
    if (this.isRedisReady && this.redisPub) {
      this.redisPub.publish('mh:events:global', JSON.stringify({ target: 'student', studentId, event, payload })).catch(() => undefined);
    }
    this.localToStudent(studentId, event, payload);
  }

  connectedStudentIds(competitionId: string): string[] {
    const room = this.competitionRooms.get(competitionId);
    if (!room) return [];
    const studentIds = new Set<string>();
    for (const client of room.values()) {
      if (client.role === 'student') {
        studentIds.add(client.userId);
      }
    }
    return [...studentIds];
  }

  kickFromCompetition(competitionId: string, studentId: string): void {
    const userEntries = this.userIndex.get(studentId);
    if (!userEntries) return;

    for (const entry of [...userEntries]) {
      if (entry.competitionId === competitionId) {
        const room = this.competitionRooms.get(competitionId);
        const client = room?.get(entry.clientId);
        if (client) {
          try {
            client.write('participant:removed', {
              competitionId,
              message: 'Your access to this competition has been removed by the host.',
            });
            client.close();
          } catch {
            // ignore
          }
        }
        this.unsubscribe(competitionId, entry.clientId);
      }
    }
  }

  private localBroadcast(competitionId: string, event: string, payload: unknown): void {
    const room = this.competitionRooms.get(competitionId);
    if (!room) return;
    for (const client of room.values()) {
      try {
        client.write(event, payload);
      } catch (err) {
        logger.debug('Error sending SSE broadcast to client', { clientId: client.id, error: err });
      }
    }
  }

  private localToHosts(competitionId: string, event: string, payload: unknown): void {
    const room = this.competitionRooms.get(competitionId);
    if (!room) return;
    for (const client of room.values()) {
      if (client.role === 'host') {
        try {
          client.write(event, payload);
        } catch (err) {
          logger.debug('Error sending SSE to host client', { clientId: client.id, error: err });
        }
      }
    }
  }

  private localToStudent(studentId: string, event: string, payload: unknown): void {
    const userEntries = this.userIndex.get(studentId);
    if (!userEntries) return;
    for (const entry of userEntries) {
      const room = this.competitionRooms.get(entry.competitionId);
      const client = room?.get(entry.clientId);
      if (client) {
        try {
          client.write(event, payload);
        } catch (err) {
          logger.debug('Error sending SSE to student client', { clientId: client.id, error: err });
        }
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // Ping every 15 seconds to prevent proxy / ALB timeouts
    this.heartbeatTimer = setInterval(() => {
      for (const room of this.competitionRooms.values()) {
        for (const client of room.values()) {
          try {
            client.write('ping', { timestamp: Date.now() });
          } catch {
            // ignore
          }
        }
      }
    }, 15000);
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const room of this.competitionRooms.values()) {
      for (const client of room.values()) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
    this.competitionRooms.clear();
    this.userIndex.clear();

    if (this.redisSub) {
      await this.redisSub.quit().catch(() => undefined);
      this.redisSub = null;
    }
    if (this.redisPub) {
      await this.redisPub.quit().catch(() => undefined);
      this.redisPub = null;
    }
    this.isRedisReady = false;
  }
}

export const sseHub = new SSEHub();
