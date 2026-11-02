import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { importBatches, questions } from '../db/schema.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import { AppError, badRequest, conflict, formatZodIssues, notFound } from '../lib/errors.js';
import { buildWorkbook, readWorkbookRows } from '../lib/spreadsheet.js';
import { newId, questionFingerprint } from '../lib/text.js';
import { questionInputSchema, type QuestionInput } from '../validation/schemas.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
const INSERT_BATCH_SIZE = 200;
const PREVIEW_TTL_MS = 60 * 60 * 1000;

export const IMPORT_COLUMNS = [
  'Question',
  'Option A',
  'Option B',
  'Option C',
  'Option D',
  'Correct Answer',
  'Difficulty',
  'Time Limit Seconds',
  'Points',
  'Topic',
  'Explanation',
] as const;

const TEMPLATE_EXAMPLES: (string | number)[][] = [
  ['What is 25% of 240?', 40, 50, 60, 80, 'C', 'EASY', 25, 10, 'Percentage', '25% of 240 is 60.'],
  ['If 3x + 7 = 22, what is x?', 3, 4, 5, 6, 'C', 'EASY', 20, 10, 'Algebra', '3x = 15, so x = 5.'],
];

export const buildCsvTemplate = (): string => toCsv([...IMPORT_COLUMNS], TEMPLATE_EXAMPLES);

export function buildXlsxTemplate(): Uint8Array<ArrayBuffer> {
  return buildWorkbook([
    {
      name: 'Questions',
      headers: [...IMPORT_COLUMNS],
      rows: TEMPLATE_EXAMPLES,
      widths: IMPORT_COLUMNS.map((header) => (header === 'Question' || header === 'Explanation' ? 48 : 16)),
    },
    {
      name: 'Instructions',
      headers: ['Column', 'Rule'],
      widths: [24, 90],
      rows: [
        ['Question', 'Required. Up to 2000 characters.'],
        ['Option A–D', 'Required. Four different, non-empty options.'],
        ['Correct Answer', 'A, B, C or D.'],
        ['Difficulty', 'EASY, MEDIUM or HARD.'],
        ['Time Limit Seconds', 'Optional. EASY 20–30 (default 25), MEDIUM 300–360 (default 300), HARD 720–900 (default 900).'],
        ['Points', 'Optional positive whole number. Defaults: EASY 10, MEDIUM 20, HARD 30.'],
        ['Topic', 'Optional. Up to 100 characters.'],
        ['Explanation', 'Optional.'],
        ['Note', 'Type values only. Formulas are rejected during import. Maximum 1000 rows per file.'],
      ],
    },
  ]);
}

interface RawRow {
  line: number;
  values: Record<string, string>;
  formulaCells?: string[];
}

type FileType = 'csv' | 'xlsx';

const REQUIRED_COLUMNS = IMPORT_COLUMNS.filter((column) => column !== 'Topic' && column !== 'Explanation');
const canonical = (header: string): string => header.trim().toLowerCase().replace(/\s+/g, ' ');

export function detectFileType(filename: string, mimetype: string, bytes: Uint8Array): FileType {
  const extension = filename.toLowerCase().split('.').pop();
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (extension === 'xlsx') {
    if (!isZip) throw badRequest('This file has an .xlsx extension but is not a valid Excel workbook.');
    return 'xlsx';
  }
  if (extension === 'csv') {
    if (isZip || bytes.includes(0)) throw badRequest('This file has a .csv extension but does not contain plain text.');
    return 'csv';
  }
  if (extension === 'xls') throw badRequest('Legacy .xls files are not supported. Save the file as .xlsx or .csv and try again.');
  throw badRequest(`Unsupported file type (${mimetype || 'unknown'}). Upload a .xlsx or .csv file.`);
}

function rowsFromMatrix(matrix: { line: number; cells: string[]; formulaCells?: string[] }[]): RawRow[] {
  const [header, ...body] = matrix;
  if (!header) throw badRequest('The file is empty.');
  const known = new Map(IMPORT_COLUMNS.map((column) => [canonical(column), column] as const));
  const mapping = new Map<number, string>();
  header.cells.forEach((cell, index) => {
    const column = known.get(canonical(cell ?? ''));
    if (column) mapping.set(index, column);
  });
  const present = new Set(mapping.values());
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length) throw badRequest(`The file is missing required column(s): ${missing.join(', ')}. Use the MathHack template.`);
  return body
    .filter((row) => row.formulaCells?.length || row.cells.some((cell) => cell.trim() !== ''))
    .map((row) => {
      const values: Record<string, string> = {};
      mapping.forEach((column, index) => {
        values[column] = (row.cells[index] ?? '').trim();
      });
      return { line: row.line, values, formulaCells: row.formulaCells };
    });
}

function parseCsvRows(bytes: Uint8Array): RawRow[] {
  let records: string[][];
  try {
    records = parseCsv(new TextDecoder('utf-8').decode(bytes), MAX_IMPORT_ROWS + 2);
  } catch (error) {
    throw badRequest(`The CSV file could not be read: ${(error as Error).message}`);
  }
  return rowsFromMatrix(records.map((cells, index) => ({ line: index + 1, cells })));
}

function parseXlsxRows(bytes: Uint8Array): RawRow[] {
  let result: ReturnType<typeof readWorkbookRows>;
  try {
    result = readWorkbookRows(bytes, MAX_IMPORT_ROWS);
  } catch {
    throw badRequest('The Excel file could not be read. Make sure it is a valid .xlsx workbook.');
  }
  if (result.tooMany) throw badRequest(`A file can contain at most ${MAX_IMPORT_ROWS} questions.`);
  return rowsFromMatrix(result.rows);
}

interface RowError {
  rowNumber: number;
  questionText: string;
  errors: { field: string; message: string }[];
}
interface ValidRow {
  rowNumber: number;
  question: QuestionInput;
}
interface DuplicateRow extends ValidRow {
  reason: string;
}

const FIELD_COLUMN: Record<string, string> = {
  questionText: 'Question',
  options: 'Options',
  'options.0': 'Option A',
  'options.1': 'Option B',
  'options.2': 'Option C',
  'options.3': 'Option D',
  correctOption: 'Correct Answer',
  difficulty: 'Difficulty',
  timeLimitSeconds: 'Time Limit Seconds',
  points: 'Points',
  topic: 'Topic',
  explanation: 'Explanation',
};

export function validateRows(rawRows: RawRow[]) {
  const valid: ValidRow[] = [];
  const invalid: RowError[] = [];
  for (const { line: rowNumber, values: row, formulaCells } of rawRows) {
    if (formulaCells?.length) {
      invalid.push({
        rowNumber,
        questionText: row.Question ?? '',
        errors: [{ field: 'Row', message: `Formulas are not allowed (cells ${formulaCells.join(', ')}). Enter plain values.` }],
      });
      continue;
    }
    const candidate = {
      questionText: row.Question ?? '',
      options: [row['Option A'], row['Option B'], row['Option C'], row['Option D']].map((option) => option ?? ''),
      correctOption: (row['Correct Answer'] ?? '').toUpperCase(),
      difficulty: (row.Difficulty ?? '').toUpperCase(),
      timeLimitSeconds: row['Time Limit Seconds'] ? row['Time Limit Seconds'] : undefined,
      points: row.Points ? row.Points : undefined,
      topic: row.Topic ?? '',
      explanation: row.Explanation ?? '',
      status: 'ACTIVE',
    };
    const result = questionInputSchema.safeParse(candidate);
    if (result.success) valid.push({ rowNumber, question: result.data });
    else {
      invalid.push({
        rowNumber,
        questionText: candidate.questionText,
        errors: formatZodIssues(result.error).map((issue) => ({ field: FIELD_COLUMN[issue.field] ?? issue.field, message: issue.message })),
      });
    }
  }
  return { valid, invalid };
}

async function splitDuplicates(db: Db, valid: ValidRow[]): Promise<{ unique: ValidRow[]; duplicates: DuplicateRow[] }> {
  const fingerprints = await Promise.all(valid.map((row) => questionFingerprint(row.question.questionText)));
  const existing = new Set<string>();
  for (let i = 0; i < fingerprints.length; i += 500) {
    const slice = fingerprints.slice(i, i + 500);
    if (!slice.length) continue;
    const found = await db.select({ fingerprint: questions.fingerprint }).from(questions).where(inArray(questions.fingerprint, slice));
    found.forEach((row) => existing.add(row.fingerprint));
  }
  const firstSeen = new Map<string, number>();
  const unique: ValidRow[] = [];
  const duplicates: DuplicateRow[] = [];
  valid.forEach((row, index) => {
    const fingerprint = fingerprints[index]!;
    if (existing.has(fingerprint)) duplicates.push({ ...row, reason: 'A question with the same text already exists in the question bank.' });
    else if (firstSeen.has(fingerprint)) duplicates.push({ ...row, reason: `Repeats the question on row ${firstSeen.get(fingerprint)}.` });
    else {
      firstSeen.set(fingerprint, row.rowNumber);
      unique.push(row);
    }
  });
  return { unique, duplicates };
}

export async function previewImport(db: Db, file: File, hostId: string) {
  if (file.size > MAX_IMPORT_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 2 MB or smaller.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileType = detectFileType(file.name, file.type, bytes);
  const rows = fileType === 'csv' ? parseCsvRows(bytes) : parseXlsxRows(bytes);
  if (rows.length === 0) throw badRequest('The file has a header row but no questions.');
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`A file can contain at most ${MAX_IMPORT_ROWS} questions.`);

  const { valid, invalid } = validateRows(rows);
  const { unique, duplicates } = await splitDuplicates(db, valid);
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  const id = newId();
  await db.insert(importBatches).values({
    id,
    createdBy: hostId,
    originalFilename: file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 255),
    fileType,
    totalRows: rows.length,
    validRows: unique,
    invalidRows: invalid,
    duplicateRows: duplicates,
    expiresAt,
  });

  return {
    batchId: id,
    fileType,
    totalRows: rows.length,
    validCount: unique.length,
    invalidCount: invalid.length,
    duplicateCount: duplicates.length,
    validRows: unique,
    invalidRows: invalid,
    duplicateRows: duplicates,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function confirmImport(db: Db, batchId: string, hostId: string, options: { includeDuplicates: boolean; status: 'DRAFT' | 'ACTIVE' }) {
  // Atomic claim: a second confirm for the same batch finds no PREVIEW batch and is rejected.
  const [batch] = await db
    .update(importBatches)
    .set({ status: 'COMMITTING' })
    .where(and(eq(importBatches.id, batchId), eq(importBatches.createdBy, hostId), eq(importBatches.status, 'PREVIEW'), gt(importBatches.expiresAt, new Date())))
    .returning();
  if (!batch) {
    const [exists] = await db
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(and(eq(importBatches.id, batchId), eq(importBatches.createdBy, hostId)))
      .limit(1);
    if (exists) throw conflict('This import has already been confirmed or is being processed.');
    throw notFound('Import preview (it may have expired; upload the file again)');
  }

  const rows = [...(batch.validRows as ValidRow[]), ...(options.includeDuplicates ? (batch.duplicateRows as DuplicateRow[]) : [])];
  const importedAt = new Date();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const values = await Promise.all(
      rows.slice(i, i + INSERT_BATCH_SIZE).map(async ({ question }) => ({
        id: newId(),
        ...question,
        status: options.status,
        fingerprint: await questionFingerprint(question.questionText),
        createdBy: hostId,
        importBatchId: batch.id,
        importedBy: hostId,
        importedAt,
      })),
    );
    if (values.length) inserted += (await db.insert(questions).values(values).returning({ id: questions.id })).length;
  }

  await db
    .update(importBatches)
    .set({ status: 'COMMITTED', insertedCount: inserted, committedAt: importedAt, validRows: [], duplicateRows: [] })
    .where(eq(importBatches.id, batch.id));
  return {
    insertedCount: inserted,
    skippedInvalid: batch.invalidRows.length,
    skippedDuplicates: options.includeDuplicates ? 0 : batch.duplicateRows.length,
  };
}

export async function errorReportCsv(db: Db, batchId: string, hostId: string): Promise<string> {
  const [batch] = await db
    .select({ invalidRows: importBatches.invalidRows, duplicateRows: importBatches.duplicateRows })
    .from(importBatches)
    .where(and(eq(importBatches.id, batchId), eq(importBatches.createdBy, hostId)))
    .limit(1);
  if (!batch) throw notFound('Import preview');
  const rows: (string | number)[][] = [];
  for (const row of batch.invalidRows as RowError[]) {
    for (const error of row.errors) rows.push([row.rowNumber, 'INVALID', error.field, error.message, row.questionText]);
  }
  for (const row of batch.duplicateRows as DuplicateRow[]) rows.push([row.rowNumber, 'DUPLICATE', 'Question', row.reason, row.question.questionText]);
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  return toCsv(['Row', 'Type', 'Field', 'Message', 'Question'], rows);
}
