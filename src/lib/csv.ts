/**
 * Small RFC 4180 CSV reader and writer. Pure JavaScript, so it runs unchanged on Workers.
 */

/** Parses CSV text into rows of cells. Handles quoted fields, escaped quotes, CRLF and a leading BOM. */
export function parseCsv(text: string, maxRows = Number.POSITIVE_INFINITY): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      pushRow();
      if (rows.length >= maxRows) return rows;
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error('A quoted field is not closed.');
  if (field !== '' || row.length) pushRow();
  return rows;
}

/**
 * Spreadsheet applications treat cells starting with these characters as formulas.
 * Exported text is prefixed with an apostrophe so it is displayed, never evaluated (OWASP CSV injection guidance).
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r＝＋－＠]/;

export type CellValue = string | number | boolean | Date | null | undefined;

export function safeCell(value: CellValue): string | number | boolean | Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function csvField(value: CellValue): string {
  const cell = safeCell(value);
  if (cell === null) return '';
  const text = cell instanceof Date ? cell.toISOString() : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CellValue[][]): string {
  const lines = [headers.map(csvField).join(','), ...rows.map((row) => row.map(csvField).join(','))];
  // BOM so Excel opens UTF-8 names correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}
