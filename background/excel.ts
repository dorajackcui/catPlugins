import { read, utils as xlsxUtils, write } from 'xlsx';

import type {
  PageSegment,
  ParseExcelResult,
  TranslationEntry
} from '../shared/translation-types.ts';
import { normalizeText, toText } from '../shared/utils.ts';

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
  rowNumberIndex: number;
  occurrenceIndexIndex: number;
  dataRows: IndexedRow[];
} {
  const [headerRow] = rows;
  const headers = headerRow?.values ?? [];
  const sourceIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'source');
  const targetIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'target');
  const rowNumberIndex = headers.findIndex((cell) =>
    ['rownumber', 'row', 'segmentnumber', 'segment'].includes(normalizeHeader(cell))
  );
  const occurrenceIndexIndex = headers.findIndex((cell) =>
    ['occurrenceindex', 'occurrence'].includes(normalizeHeader(cell))
  );

  if (sourceIndex !== -1 && targetIndex !== -1) {
    return {
      sourceIndex,
      targetIndex,
      rowNumberIndex,
      occurrenceIndexIndex,
      dataRows: rows.slice(1)
    };
  }

  return {
    sourceIndex: 0,
    targetIndex: 1,
    rowNumberIndex: -1,
    occurrenceIndexIndex: -1,
    dataRows: rows
  };
}

function normalizeRowNumber(value: unknown): string | undefined {
  const rowNumber = toText(value).trim().replace(/\.$/, '');
  return /^\d+$/.test(rowNumber) ? rowNumber : undefined;
}

function normalizeOccurrenceIndex(value: unknown): number | null {
  const occurrenceIndex = Number.parseInt(toText(value).trim(), 10);
  return Number.isFinite(occurrenceIndex) && occurrenceIndex > 0
    ? occurrenceIndex
    : null;
}

function toRawCellText(value: unknown): string {
  return toText(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
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
    rowNumberIndex,
    occurrenceIndexIndex,
    dataRows
  } = resolveColumnMapping(visibleRows);
  const occurrences = new Map<string, number>();
  const entries: TranslationEntry[] = [];

  dataRows.forEach(({ rowNumber: excelRowIndex, values }) => {
    const sourceRaw = toRawCellText(values[sourceIndex]);
    const targetRaw = toRawCellText(values[targetIndex]);
    const exportedRowNumber =
      rowNumberIndex >= 0
        ? normalizeRowNumber(values[rowNumberIndex])
        : undefined;

    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized || !normalizeText(targetRaw)) {
      return;
    }

    const computedOccurrence = (occurrences.get(sourceNormalized) ?? 0) + 1;
    occurrences.set(sourceNormalized, computedOccurrence);
    const exportedOccurrence =
      occurrenceIndexIndex >= 0
        ? normalizeOccurrenceIndex(values[occurrenceIndexIndex])
        : null;

    entries.push({
      rowIndex: excelRowIndex,
      rowNumber: exportedRowNumber,
      sourceRaw,
      sourceNormalized,
      targetRaw,
      occurrenceIndex: exportedOccurrence ?? computedOccurrence
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

export function buildSourceExportWorkbook(segments: PageSegment[]): Uint8Array {
  const workbook = xlsxUtils.book_new();
  const rows: Array<Array<string | number>> = [
    ['rowNumber', 'source', 'target', 'occurrenceIndex'],
    ...segments.map((segment) => [
      segment.rowNumber ?? '',
      segment.sourceRaw,
      segment.targetRaw,
      segment.occurrenceIndex
    ])
  ];
  const worksheet = xlsxUtils.aoa_to_sheet(rows);
  const worksheetWithColumns = worksheet as typeof worksheet & {
    '!cols'?: Array<{ wch: number }>;
  };

  worksheetWithColumns['!cols'] = [
    { wch: 12 },
    { wch: 60 },
    { wch: 60 },
    { wch: 16 }
  ];
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sources');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer | Uint8Array;
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}
