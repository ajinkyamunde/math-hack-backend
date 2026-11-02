/**
 * Excel reading and writing with SheetJS, which is pure JavaScript and works in memory, so it runs on Workers
 * (no filesystem, no Node streams).
 */
import * as XLSX from 'xlsx';
import { safeCell, type CellValue } from './csv.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface SheetSpec {
  name: string;
  headers: string[];
  rows: CellValue[][];
  /** Column widths in characters; defaults to a width based on the header. */
  widths?: number[];
  autoFilter?: boolean;
}

/** Builds an .xlsx workbook. Text cells are formula-neutralised, exactly like the CSV exports. */
export function buildWorkbook(sheets: SheetSpec[]): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  for (const spec of sheets) {
    const data = [spec.headers, ...spec.rows.map((row) => row.map((cell) => safeCell(cell)))];
    const sheet = XLSX.utils.aoa_to_sheet(data, { cellDates: true, dateNF: 'yyyy-mm-dd hh:mm:ss' });
    sheet['!cols'] = spec.headers.map((header, index) => ({ wch: spec.widths?.[index] ?? Math.max(12, Math.min(48, header.length + 4)) }));
    if (spec.autoFilter && spec.rows.length) {
      sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: spec.headers.length - 1 } }) };
    }
    XLSX.utils.book_append_sheet(workbook, sheet, spec.name.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}

export interface ReadRow {
  line: number;
  cells: string[];
  formulaCells?: string[];
}

/**
 * Reads the "Questions" sheet (or the first sheet) as text rows. Formula cells are reported, never evaluated:
 * imported spreadsheets are data, not code.
 */
export function readWorkbookRows(bytes: Uint8Array, maxRows: number): { rows: ReadRow[]; tooMany: boolean } {
  const workbook = XLSX.read(bytes, { type: 'array', cellFormula: true, cellDates: true, sheetRows: maxRows + 2 });
  const name = workbook.SheetNames.find((n) => n.toLowerCase() === 'questions') ?? workbook.SheetNames[0];
  const sheet = name ? workbook.Sheets[name] : undefined;
  if (!sheet || !sheet['!ref']) return { rows: [], tooMany: false };
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const fullRange = sheet['!fullref'] ? XLSX.utils.decode_range(sheet['!fullref']) : range;
  const width = Math.min(range.e.c - range.s.c + 1, 30);
  const rows: ReadRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const cells: string[] = [];
    const formulas: string[] = [];
    let any = false;
    for (let c = range.s.c; c < range.s.c + width; c += 1) {
      const address = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[address] as XLSX.CellObject | undefined;
      if (!cell) {
        cells.push('');
        continue;
      }
      any = true;
      if (cell.f) {
        formulas.push(address);
        cells.push('');
      } else if (cell.v instanceof Date) {
        cells.push(cell.v.toISOString().slice(0, 10));
      } else if (cell.t === 'e' || cell.v === undefined || cell.v === null) {
        cells.push('');
      } else {
        cells.push(String(cell.v));
      }
    }
    if (any) rows.push({ line: r + 1, cells, formulaCells: formulas.length ? formulas : undefined });
  }
  return { rows, tooMany: fullRange.e.r - fullRange.s.r > maxRows };
}

/**
 * Excel dates carry no time zone, so a UTC instant would show 5.5 hours off for a host in India.
 * Convert to the wall-clock time in the host's zone and write that instead.
 */
export function inTimeZone(date: Date | null, timeZone = 'UTC'): Date | null {
  if (!date) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!));
}
