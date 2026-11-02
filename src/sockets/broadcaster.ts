/**
 * Seam between domain services and Realtime Notifications (SSE).
 * Services publish events through this module so they stay testable.
 */
import { sseHub } from '../realtime/sseHub.js';

export interface Broadcaster {
  toCompetition(competitionId: string, event: string, payload: unknown): void;
  toHosts(competitionId: string, event: string, payload: unknown): void;
  toStudent(studentId: string, event: string, payload: unknown): void;
  connectedStudentIds(competitionId: string): Promise<string[]>;
  kickFromCompetition(competitionId: string, studentId: string): Promise<void> | void;
}

const sseBroadcaster: Broadcaster = {
  toCompetition: (competitionId, event, payload) => sseHub.broadcast(competitionId, event, payload),
  toHosts: (competitionId, event, payload) => sseHub.toHosts(competitionId, event, payload),
  toStudent: (studentId, event, payload) => sseHub.toStudent(studentId, event, payload),
  connectedStudentIds: async (competitionId) => sseHub.connectedStudentIds(competitionId),
  kickFromCompetition: (competitionId, studentId) => sseHub.kickFromCompetition(competitionId, studentId),
};

let current: Broadcaster = sseBroadcaster;

export const rooms = {
  competition: (id: string) => `competition:${id}`,
  hosts: (id: string) => `competition:${id}:hosts`,
  student: (id: string) => `student:${id}`,
};

export function setBroadcaster(broadcaster: Broadcaster | undefined): void {
  current = broadcaster ?? sseBroadcaster;
}

export function broadcaster(): Broadcaster {
  return current;
}
