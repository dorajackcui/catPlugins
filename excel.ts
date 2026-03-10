import { read, utils as xlsxUtils } from 'xlsx';

import type { ParseExcelResult, TranslationEntry } from './types.ts';
import { normalizeText, toText } from './utils.ts';

function normalizeHeader(value: unknown): string {
  return toText(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function findColumnIndex(headers: unknown[], expected: 'source' | 'target'): number {
  return headers.findIndex((header) => normalizeHeader(header) === expected);
}

export function parseExcelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string
): ParseExcelResult {
  const workbook = read(buffer, { type: 'array' });
  const [sheetName] = workbook.SheetNames;

  if (!sheetName) {
    throw new Error('Workbook does not contain any sheets.');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = xlsxUtils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false
  });

  if (!rows.length) {
    throw new Error('The first sheet is empty.');
  }

  const [headerRow, ...dataRows] = rows;
  const sourceIndex = findColumnIndex(headerRow, 'source');
  const targetIndex = findColumnIndex(headerRow, 'target');

  if (sourceIndex === -1 || targetIndex === -1) {
    throw new Error('The first sheet must contain source and target columns.');
  }

  const occurrences = new Map<string, number>();
  const entries: TranslationEntry[] = [];

  dataRows.forEach((row, rowOffset) => {
    const sourceRaw = normalizeText(toText(row[sourceIndex]));
    const targetRaw = normalizeText(toText(row[targetIndex]));

    if (!sourceRaw || !targetRaw) {
      return;
    }

    const sourceNormalized = sourceRaw;
    const nextOccurrence = (occurrences.get(sourceNormalized) ?? 0) + 1;
    occurrences.set(sourceNormalized, nextOccurrence);

    entries.push({
      rowIndex: rowOffset + 2,
      sourceRaw,
      sourceNormalized,
      targetRaw,
      occurrenceIndex: nextOccurrence
    });
  });

  return {
    entries,
    meta: {
      fileName,
      entryCount: entries.length,
      uploadedAt: new Date().toISOString(),
      sheetName
    }
  };
}
