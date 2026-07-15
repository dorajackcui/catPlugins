import { normalizeFillOptions } from './fill-options.ts';
import { placeholdersMatch } from './qa.ts';
import type {
  FillOptions,
  PageSegment,
  PreviewItem,
  PreviewResult,
  TranslationEntry
} from '../shared/types.ts';
import {
  normalizeGientTransInlineMarkup,
  stripGientTransInlineMarkup
} from '../platforms/gientrans/markup.ts';
import { normalizePhraseTagClipText } from '../platforms/phrase/markup.ts';
import { normalizeText } from '../shared/utils.ts';

export function buildMatchKey(sourceNormalized: string, occurrenceIndex: number): string {
  return `source:${sourceNormalized}::${occurrenceIndex}`;
}

function buildRowNumberMatchKey(rowNumber: string): string {
  return `row:${rowNumber}`;
}

export function createEntryLookup(
  entries: TranslationEntry[]
): Map<string, TranslationEntry> {
  const lookup = new Map<string, TranslationEntry>();

  for (const entry of entries) {
    if (entry.rowNumber) {
      lookup.set(buildRowNumberMatchKey(entry.rowNumber), entry);
    }

    addSourceLookupEntry(lookup, entry, entry.sourceNormalized);
    addSourceLookupEntry(lookup, entry, normalizePhraseTagClipText(entry.sourceRaw));

    const canonicalGientTransSource = normalizeText(
      normalizeGientTransInlineMarkup(entry.sourceRaw)
    );
    addSourceLookupEntry(lookup, entry, canonicalGientTransSource);

    addSourceLookupEntry(lookup, entry, stripGientTransInlineMarkup(entry.sourceRaw));
  }

  return lookup;
}

export function classifySegment(
  entryLookup: Map<string, TranslationEntry>,
  segment: PageSegment,
  fillOptions?: FillOptions | null
): PreviewItem {
  const normalizedFillOptions = normalizeFillOptions(fillOptions);
  const rowNumberEntry = segment.rowNumber
    ? entryLookup.get(buildRowNumberMatchKey(segment.rowNumber))
    : undefined;

  if (
    segment.platform === 'memoq' &&
    segment.rowNumber &&
    rowNumberEntry &&
    normalizeText(rowNumberEntry.sourceNormalized) !== normalizeText(segment.sourceNormalized)
  ) {
    return {
      ...segment,
      status: 'unmatched',
      reason: `Excel row ${segment.rowNumber} source does not match the current memoQ source.`
    };
  }

  const entry = rowNumberEntry ?? findEntryBySource(entryLookup, segment);

  if (!entry) {
    return {
      ...segment,
      status: 'unmatched',
      reason: 'No matching source row found in Excel.'
    };
  }

  if (!segment.isEmptyTarget && segment.platform !== 'gientrans') {
    return {
      ...segment,
      status: 'alreadyTranslated',
      translation: entry.targetRaw,
      excelRowIndex: entry.rowIndex,
      reason: 'Segment already has a translation.'
    };
  }

  if (
    normalizedFillOptions.validatePlaceholders &&
    !placeholdersMatch(segment.sourceRaw, entry.targetRaw)
  ) {
    return {
      ...segment,
      status: 'placeholderError',
      translation: entry.targetRaw,
      excelRowIndex: entry.rowIndex,
      reason: 'Placeholder mismatch between source and translation.'
    };
  }

  return {
    ...segment,
    status: 'ready',
    translation: entry.targetRaw,
    excelRowIndex: entry.rowIndex
  };
}

function findEntryBySource(
  entryLookup: Map<string, TranslationEntry>,
  segment: PageSegment
): TranslationEntry | undefined {
  const exactEntry = entryLookup.get(
    buildMatchKey(segment.sourceNormalized, segment.occurrenceIndex)
  );
  if (exactEntry) {
    return exactEntry;
  }

  if (segment.platform !== 'gientrans') {
    if (segment.platform === 'phrase' || segment.platform === 'generic') {
      const canonicalPhraseSource = normalizePhraseTagClipText(segment.sourceRaw);
      return entryLookup.get(
        buildMatchKey(canonicalPhraseSource, segment.occurrenceIndex)
      );
    }

    return undefined;
  }

  const canonicalGientTransSource = normalizeText(
    normalizeGientTransInlineMarkup(segment.sourceRaw)
  );
  const canonicalEntry = entryLookup.get(
    buildMatchKey(canonicalGientTransSource, segment.occurrenceIndex)
  );
  if (canonicalEntry) {
    return canonicalEntry;
  }

  const sourceWithoutGientTransTags = stripGientTransInlineMarkup(segment.sourceRaw);
  if (!sourceWithoutGientTransTags) {
    return undefined;
  }

  return entryLookup.get(
    buildMatchKey(sourceWithoutGientTransTags, segment.occurrenceIndex)
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
  const items = segments.map((segment) => classifySegment(lookup, segment, fillOptions));
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

export function applyMemoqPreviewCorrection(preview: PreviewResult): PreviewResult {
  // Kept as an identity function for existing background call sites. Older
  // memoQ builds exposed a phantom unmatched row, but deleting an arbitrary
  // unmatched item also hid legitimate source rows.
  return preview;
}
