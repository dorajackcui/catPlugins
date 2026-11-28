import { normalizeFillOptions } from './fill-options.ts';
import { placeholdersMatch } from './qa.ts';
import type {
  FillOptions,
  PageSegment,
  PreviewItem,
  PreviewResult,
  TranslationEntry
} from '../shared/translation-types.ts';
import {
  normalizeGientTransEditorMarkup,
  normalizeGientTransInlineMarkup,
  stripGientTransInlineMarkup
} from './gientrans-markup.ts';
import {
  hasMemoqInlineTagMarkup,
  memoqProtectedSourceMatchesExcelSource
} from './memoq-markup.ts';
import { prepareMemoqTranslation, type MemoqMarkerFillPlan } from './memoq-marker-fill.ts';
import { preparePhraseTranslation, type PhraseMarkerFillPlan } from './phrase-marker-fill.ts';
import { PhraseSourceLookup } from './phrase-source-matching.ts';
import { normalizeText } from '../shared/utils.ts';

interface TranslationLookup {
  byKey: Map<string, TranslationEntry>;
  memoqFallback: TranslationEntry[];
  phrase: PhraseSourceLookup;
}

function buildMatchKey(sourceNormalized: string, occurrenceIndex: number): string {
  return `source:${sourceNormalized}::${occurrenceIndex}`;
}

function buildRowNumberMatchKey(rowNumber: string): string {
  return `row:${rowNumber}`;
}

function gientransSourceKey(source: string, occurrence: number): string {
  return `gientrans:${buildMatchKey(normalizeText(normalizeGientTransEditorMarkup(source)), occurrence)}`;
}

export function createEntryLookup(
  entries: TranslationEntry[]
): TranslationLookup {
  const byKey = new Map<string, TranslationEntry>();

  for (const entry of entries) {
    if (entry.rowNumber) {
      byKey.set(buildRowNumberMatchKey(entry.rowNumber), entry);
    }

    addSourceLookupEntry(byKey, entry, entry.sourceNormalized);

    const canonicalGientTransSource = normalizeText(
      normalizeGientTransInlineMarkup(entry.sourceRaw)
    );
    addSourceLookupEntry(byKey, entry, canonicalGientTransSource);
    const editorKey = gientransSourceKey(entry.sourceRaw, entry.occurrenceIndex);
    if (!byKey.has(editorKey)) byKey.set(editorKey, entry);

    addSourceLookupEntry(byKey, entry, stripGientTransInlineMarkup(entry.sourceRaw));
  }

  return {
    byKey,
    // Numbered memoQ exports must stay on their document rows.
    memoqFallback: entries.filter(entry => !entry.matchMemoqRowOnly),
    phrase: new PhraseSourceLookup(entries)
  };
}

export function classifySegment(
  entryLookup: TranslationLookup,
  segment: PageSegment,
  fillOptions?: FillOptions | null
): { item: PreviewItem; markerFillPlan?: MemoqMarkerFillPlan; phraseMarkerFillPlan?: PhraseMarkerFillPlan } {
  const { validatePlaceholders } = normalizeFillOptions(fillOptions);
  const rowNumberEntry = segment.rowNumber
    ? entryLookup.byKey.get(buildRowNumberMatchKey(segment.rowNumber))
    : undefined;
  const matchingRowNumberEntry =
    rowNumberEntry &&
    (segment.platform !== 'memoq' || memoqSourcesMatch(rowNumberEntry, segment))
      ? rowNumberEntry
      : undefined;
  const entry = segment.platform === 'phrase'
    ? entryLookup.phrase.find(segment)
    : matchingRowNumberEntry ?? findEntryBySource(entryLookup, segment);
  if (!entry) {
    const reason = entry === null
      ? 'Excel has different translations for this Phrase source without a unique row match.'
      : rowNumberEntry && (segment.platform === 'memoq' || segment.platform === 'phrase')
        ? `Excel row ${segment.rowNumber} source does not match the current ${segment.platform === 'memoq' ? 'memoQ' : 'Phrase'} source.`
        : 'No matching source row found in Excel.';
    return { item: { ...segment, status: 'unmatched', reason } };
  }

  const matched = { ...segment, translation: entry.targetRaw, excelRowIndex: entry.rowIndex };
  if (!segment.isEmptyTarget && segment.platform !== 'gientrans') {
    return { item: { ...matched, status: 'alreadyTranslated', reason: 'Segment already has a translation.' } };
  }

  if (segment.platform === 'memoq') {
    const prepared = prepareMemoqTranslation(entry, segment, validatePlaceholders);
    if (!prepared.ok) return { item: { ...matched, status: 'placeholderError', reason: prepared.reason } };
    return { item: { ...matched, status: 'ready' }, markerFillPlan: prepared.plan };
  }
  if (segment.platform === 'phrase' && segment.phraseSourceMarkers?.length) {
    const prepared = preparePhraseTranslation(
      segment.sourceRaw, segment.phraseSourceMarkers, entry.targetRaw, validatePlaceholders, entry.phraseExportedTarget
    );
    if (!prepared.ok) return { item: { ...matched, status: 'placeholderError', reason: prepared.reason } };
    return { item: { ...matched, status: 'ready' }, phraseMarkerFillPlan: prepared.plan };
  }
  if (validatePlaceholders && !placeholdersMatch(segment.sourceRaw, entry.targetRaw, segment.platform, segment.placeholderTokens)) {
    return { item: { ...matched, status: 'placeholderError', reason: 'Placeholder mismatch between source and translation.' } };
  }
  return { item: { ...matched, status: 'ready' } };
}

function findEntryBySource(
  { byKey, memoqFallback }: TranslationLookup,
  segment: PageSegment
): TranslationEntry | undefined {
  const exactEntry = byKey.get(
    buildMatchKey(segment.sourceNormalized, segment.occurrenceIndex)
  );
  if (exactEntry && (segment.platform !== 'memoq' || !exactEntry.matchMemoqRowOnly)) {
    return exactEntry;
  }

  if (segment.platform === 'memoq') {
    const protectedSourceMatches = memoqFallback.filter(entry =>
      memoqProtectedSourceMatchesExcelSource(segment.sourceRaw, entry.sourceRaw)
    );
    const occurrenceMatches = protectedSourceMatches.filter(
      (entry) => entry.occurrenceIndex === segment.occurrenceIndex
    );
    if (occurrenceMatches.length === 1) {
      return occurrenceMatches[0];
    }

    // A scan can start partway through a job. A globally unique source remains safe
    // when the scan-local occurrence index differs from the workbook index.
    return protectedSourceMatches.length === 1 ? protectedSourceMatches[0] : undefined;
  }

  if (segment.platform !== 'gientrans') return undefined;

  const canonicalEntry = byKey.get(
    gientransSourceKey(segment.sourceRaw, segment.occurrenceIndex)
  );
  if (canonicalEntry) {
    return canonicalEntry;
  }

  const sourceWithoutGientTransTags = stripGientTransInlineMarkup(segment.sourceRaw);
  if (!sourceWithoutGientTransTags) {
    return undefined;
  }

  return byKey.get(
    buildMatchKey(sourceWithoutGientTransTags, segment.occurrenceIndex)
  );
}

function memoqSourcesMatch(
  entry: TranslationEntry,
  segment: PageSegment
): boolean {
  if (entry.matchMemoqRowOnly && hasMemoqInlineTagMarkup(entry.sourceRaw)) {
    return entry.sourceNormalized === segment.sourceNormalized;
  }
  return (
    normalizeText(entry.sourceNormalized) === normalizeText(segment.sourceNormalized) ||
    memoqProtectedSourceMatchesExcelSource(segment.sourceRaw, entry.sourceRaw)
  );
}

function addSourceLookupEntry(
  lookup: Map<string, TranslationEntry>,
  entry: TranslationEntry,
  sourceNormalized: string
): void {
  if (!sourceNormalized) {
    return;
  }

  const key = buildMatchKey(sourceNormalized, entry.occurrenceIndex);
  if (!lookup.has(key)) {
    lookup.set(key, entry);
  }
}

export function summarizePreview(items: PreviewItem[]): PreviewResult {
  const totalSegments = items.length;
  const matched = items.filter((item) => item.status !== 'unmatched').length;
  const alreadyTranslated = items.filter(
    (item) => item.status === 'alreadyTranslated'
  ).length;
  const placeholderErrors = items.filter(
    (item) => item.status === 'placeholderError'
  ).length;
  const readyToFill = items.filter((item) => item.status === 'ready').length;

  return {
    totalSegments,
    matched,
    alreadyTranslated,
    placeholderErrors,
    readyToFill,
    skipped: totalSegments - readyToFill,
    items,
    generatedAt: new Date().toISOString()
  };
}

export function buildPreview(
  entries: TranslationEntry[],
  segments: PageSegment[],
  fillOptions?: FillOptions | null
): PreviewResult {
  const lookup = createEntryLookup(entries);
  const items = segments.map((segment) => classifySegment(lookup, segment, fillOptions).item);
  return summarizePreview(items);
}

export function applyFilledToPreview(
  preview: PreviewResult,
  filledDomIds: string[]
): PreviewResult {
  const filledIdSet = new Set(filledDomIds);
  const updatedItems = preview.items.map((item) => {
    if (item.status !== 'ready' || !filledIdSet.has(item.domId)) {
      return item;
    }

    return {
      ...item,
      status: 'alreadyTranslated' as const,
      reason: 'Filled by Phrase Bulk Fill.'
    };
  });

  return summarizePreview(updatedItems);
}
