import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { authOf } from '../context.js';
import { jsonBody, requireAuth, requireHost, requireStudent, uploadedFile } from '../auth/middleware.js';
import { badRequest, parse } from '../lib/errors.js';
import { recordAudit } from '../services/audit.js';
import * as people from '../services/participants.js';
import * as students from '../services/students.js';
import { createParticipantSchema, pagination } from '../validation/schemas.js';

export const studentRoutes = new Hono<AppEnv>();
studentRoutes.use('*', requireAuth);

studentRoutes.get('/me/history', requireStudent, async (c) => {
  const query = parse(pagination, c.req.query());
  return c.json(await students.studentHistory(c.get('db'), authOf(c).id, query));
});

studentRoutes.get('/', requireHost, async (c) => {
  const query = parse(pagination.extend({ search: z.string().trim().max(100).optional() }), c.req.query());
  return c.json(await students.listStudents(c.get('db'), query));
});

studentRoutes.get('/roster', requireHost, async (c) =>
  c.json({ entries: await students.rosterSize(c.get('db')), enforced: c.get('config').rosterEnforced }),
);

studentRoutes.post('/roster', requireHost, async (c) => {
  const file = await uploadedFile(c, 2 * 1024 * 1024, 'Attach the roster CSV in the "file" field.');
  if (!file.name.toLowerCase().endsWith('.csv')) throw badRequest('The roster must be a .csv file.');
  const db = c.get('db');
  const result = await students.importRoster(db, file, authOf(c).id);
  await recordAudit(db, { actorId: authOf(c).id, actorRole: 'host', action: 'roster.import', details: { imported: result.imported } });
  return c.json(result, 201);
});

export const hostRoutes = new Hono<AppEnv>();
hostRoutes.use('*', requireAuth, requireHost);

hostRoutes.get('/overview', async (c) => c.json(await students.hostOverview(c.get('db'), c.get('realtime'), authOf(c).id)));

hostRoutes.get('/assignable-competitions', async (c) => c.json({ items: await people.assignableCompetitions(c.get('db'), authOf(c).id) }));

hostRoutes.post('/participants', async (c) => {
  const input = parse(createParticipantSchema, await jsonBody(c));
  const result = await people.createParticipant(c.get('db'), c.get('config'), c.get('realtime'), input, authOf(c).id);
  return c.json(result, 201);
});
