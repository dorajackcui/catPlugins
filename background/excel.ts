import { read, utils as xlsxUtils, write } from 'xlsx';

import type {
  PageSegment,
  ParseExcelResult,
  PhraseExportedTarget,
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
  originalSourceIndex: number;
  phraseTargetIndex: number;
  dataRows: IndexedRow[];
} {
  const [headerRow] = rows;
  const headers = headerRow?.values ?? [];
  const sourceIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'source');
  const targetIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'target');
  const originalSourceIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'originalsource');
  const phraseTargetIndex = headers.findIndex((cell) => normalizeHeader(cell) === 'phrasetargetmarkers');
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
      originalSourceIndex,
      phraseTargetIndex,
      dataRows: rows.slice(1)
    };
  }

  return {
    sourceIndex: 0,
    targetIndex: 1,
    rowNumberIndex: -1,
    occurrenceIndexIndex: -1,
    originalSourceIndex: -1,
    phraseTargetIndex: -1,
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

function readPhraseExportedTarget(value: unknown): PhraseExportedTarget | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const data = JSON.parse(value) as Partial<PhraseExportedTarget> | null;
    if (typeof data?.text === 'string' && Array.isArray(data.markers) && data.markers.every((marker) =>
      marker && typeof marker.token === 'string' && marker.token &&
      Number.isSafeInteger(marker.offset) && marker.offset >= 0
    )) {
      return {
        text: data.text,
        markers: data.markers.map(({ token, offset }) => ({ token, offset }))
      };
    }
  } catch {
    // A workbook edited outside the extension can omit its saved marker information.
  }
  return undefined;
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
    originalSourceIndex,
    phraseTargetIndex,
    dataRows
  } = resolveColumnMapping(visibleRows);
  const occurrences = new Map<string, number>();
  const entries: TranslationEntry[] = [];
  const numberedExport = rowNumberIndex >= 0 && occurrenceIndexIndex >= 0;
  const readCellText = numberedExport ? toText : toRawCellText;

  dataRows.forEach(({ rowNumber: excelRowIndex, values }) => {
    const sourceRaw = readCellText(values[sourceIndex]);
    const targetRaw = readCellText(values[targetIndex]);
    const originalSource = originalSourceIndex >= 0 ? toText(values[originalSourceIndex]) : '';
    const exportedRowNumber =
      rowNumberIndex >= 0
        ? normalizeRowNumber(values[rowNumberIndex])
        : undefined;
    const phraseExportedTarget = exportedRowNumber && numberedExport && phraseTargetIndex >= 0
      ? readPhraseExportedTarget(values[phraseTargetIndex])
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
      ...(exportedRowNumber && numberedExport ? { matchMemoqRowOnly: true } : {}),
      ...(originalSource ? { originalSource } : {}),
      ...(phraseExportedTarget ? { phraseExportedTarget } : {}),
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
  const includeOriginal = segments.some(segment => segment.platform === 'memoq' && segment.originalSource !== undefined);
  const phraseTargets = segments.map((segment) => {
    if (segment.platform !== 'phrase' || !segment.rowNumber ||
      !segment.phraseSourceMarkers?.length || !segment.targetRaw) return '';
    const markers = (segment.phraseTargetMarkers ?? []).map(({ token, offset }) => ({ token, offset }));
    const value = JSON.stringify({ text: segment.targetRaw, markers } satisfies PhraseExportedTarget);
    return value.length <= 32_767 ? value : '';
  });
  const includePhraseTargets = phraseTargets.some(Boolean);
  const rows: Array<Array<string | number>> = [
    ['rowNumber', 'source', 'target', 'occurrenceIndex', ...(includeOriginal ? ['originalSource'] : []),
      ...(includePhraseTargets ? ['phraseTargetMarkers'] : [])],
    ...segments.map((segment, index) => [
      segment.rowNumber ?? '',
      segment.sourceRaw,
      segment.targetRaw,
      segment.occurrenceIndex,
      ...(includeOriginal ? [segment.originalSource ?? ''] : []),
      ...(includePhraseTargets ? [phraseTargets[index]] : [])
    ])
  ];
  const worksheet = xlsxUtils.aoa_to_sheet(rows);
  const worksheetWithColumns = worksheet as typeof worksheet & {
    '!cols'?: Array<{ wch: number; hidden?: boolean }>;
  };

  worksheetWithColumns['!cols'] = [
    { wch: 12 },
    { wch: 60 },
    { wch: 60 },
    { wch: 16 },
    ...(includeOriginal ? [{ wch: 72 }] : []),
    ...(includePhraseTargets ? [{ wch: 20, hidden: true }] : [])
  ];
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sources');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: includePhraseTargets }) as ArrayBuffer | Uint8Array;
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}
