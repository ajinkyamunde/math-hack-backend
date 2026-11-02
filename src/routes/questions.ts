import { Hono } from 'hono';
import type { AppEnv } from '../context.js';
import { authOf } from '../context.js';
import { jsonBody, requireAuth, requireHost, uploadedFile } from '../auth/middleware.js';
import { parse } from '../lib/errors.js';
import { XLSX_CONTENT_TYPE } from '../lib/spreadsheet.js';
import { recordAudit } from '../services/audit.js';
import * as importer from '../services/imports.js';
import * as bank from '../services/questions.js';
import { idParams, importConfirmSchema, objectId, questionInputSchema, questionListQuerySchema } from '../validation/schemas.js';
import { z } from 'zod';

export const questionRoutes = new Hono<AppEnv>();
questionRoutes.use('*', requireAuth, requireHost);

const download = (contentType: string, filename: string) => ({
  'content-type': contentType,
  'content-disposition': `attachment; filename="${filename}"`,
  'cache-control': 'no-store',
});

questionRoutes.get('/template.csv', (c) =>
  c.body(importer.buildCsvTemplate(), 200, download('text/csv; charset=utf-8', 'mathhack-question-template.csv')),
);
questionRoutes.get('/template.xlsx', (c) =>
  c.body(importer.buildXlsxTemplate(), 200, download(XLSX_CONTENT_TYPE, 'mathhack-question-template.xlsx')),
);

questionRoutes.post('/import/preview', async (c) => {
  const file = await uploadedFile(c, importer.MAX_IMPORT_BYTES, 'Attach a .xlsx or .csv file in the "file" field.');
  return c.json(await importer.previewImport(c.get('db'), file, authOf(c).id));
});

questionRoutes.post('/import/confirm', async (c) => {
  const body = parse(importConfirmSchema, await jsonBody(c));
  const db = c.get('db');
  const hostId = authOf(c).id;
  const result = await importer.confirmImport(db, body.batchId, hostId, body);
  await recordAudit(db, { actorId: hostId, actorRole: 'host', action: 'questions.import', details: { batchId: body.batchId, ...result } });
  return c.json(result, 201);
});

questionRoutes.get('/import/:batchId/errors.csv', async (c) => {
  const { batchId } = parse(z.object({ batchId: objectId }), c.req.param());
  const csv = await importer.errorReportCsv(c.get('db'), batchId, authOf(c).id);
  return c.body(csv, 200, download('text/csv; charset=utf-8', 'mathhack-import-errors.csv'));
});

questionRoutes.get('/topics', async (c) => c.json({ topics: await bank.listTopics(c.get('db')) }));
questionRoutes.get('/', async (c) => c.json(await bank.listQuestions(c.get('db'), parse(questionListQuerySchema, c.req.query()))));
questionRoutes.post('/', async (c) => {
  const input = parse(questionInputSchema, await jsonBody(c));
  return c.json({ question: await bank.createQuestion(c.get('db'), input, authOf(c).id) }, 201);
});
questionRoutes.get('/:id', async (c) => {
  const { id } = parse(idParams, c.req.param());
  return c.json({ question: await bank.getQuestion(c.get('db'), id) });
});
questionRoutes.put('/:id', async (c) => {
  const { id } = parse(idParams, c.req.param());
  const input = parse(questionInputSchema, await jsonBody(c));
  return c.json({ question: await bank.updateQuestion(c.get('db'), id, input) });
});
questionRoutes.delete('/:id', async (c) => {
  const { id } = parse(idParams, c.req.param());
  await bank.deleteQuestion(c.get('db'), id);
  return c.body(null, 204);
});
questionRoutes.post('/:id/duplicate', async (c) => {
  const { id } = parse(idParams, c.req.param());
  return c.json({ question: await bank.duplicateQuestion(c.get('db'), id, authOf(c).id) }, 201);
});
