import { read, utils as xlsxUtils } from 'xlsx';

import type { ParseExcelResult, TranslationEntry } from './types.ts';
import { normalizeText, toText } from './utils.ts';

interface IndexedRow {
  rowNumber: number;
  values: unknown[];
}

function normalizeHeader(value: unknown): string {
  return toText(value).trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function resolveColumnMapping(rows: IndexedRow[]): {
  sourceIndex: number;
  targetIndex: number;
  dataRows: IndexedRow[];
} {
  const [headerRow] = rows;
  const sourceIndex = (headerRow?.values ?? []).findIndex(
    (cell) => normalizeHeader(cell) === 'source'
  );
  const targetIndex = (headerRow?.values ?? []).findIndex(
    (cell) => normalizeHeader(cell) === 'target'
  );

  if (sourceIndex !== -1 && targetIndex !== -1) {
    return {
      sourceIndex,
      targetIndex,
      dataRows: rows.slice(1)
    };
  }

  return {
    sourceIndex: 0,
    targetIndex: 1,
    dataRows: rows
  };
}

export function parseExcelBuffer(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string
): ParseExcelResult {
  const workbook = read(buffer, { type: 'array', cellStyles: true });
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
  const visibleRows = rows
    .map<IndexedRow>((values, index) => ({
      rowNumber: index + 1,
      values
    }))
    .filter(({ rowNumber }) => !sheet['!rows']?.[rowNumber - 1]?.hidden);

  if (!visibleRows.length) {
    throw new Error('The first sheet is empty.');
  }

  const {
    sourceIndex,
    targetIndex,
    dataRows
  } = resolveColumnMapping(visibleRows);
  const occurrences = new Map<string, number>();
  const entries: TranslationEntry[] = [];

  dataRows.forEach(({ rowNumber, values }) => {
    const sourceRaw = normalizeText(toText(values[sourceIndex]));
    const targetRaw = normalizeText(toText(values[targetIndex]));

    if (!sourceRaw || !targetRaw) {
      return;
    }

    const sourceNormalized = sourceRaw;
    const nextOccurrence = (occurrences.get(sourceNormalized) ?? 0) + 1;
    occurrences.set(sourceNormalized, nextOccurrence);

    entries.push({
      rowIndex: rowNumber,
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
