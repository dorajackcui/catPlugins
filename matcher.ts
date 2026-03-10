import { placeholdersMatch } from './qa.ts';
import type {
  PageSegment,
  PreviewItem,
  PreviewResult,
  TranslationEntry
} from './types.ts';

export function buildMatchKey(sourceNormalized: string, occurrenceIndex: number): string {
  return `${sourceNormalized}::${occurrenceIndex}`;
}

export function createEntryLookup(
  entries: TranslationEntry[]
): Map<string, TranslationEntry> {
  return new Map(
    entries.map((entry) => [
      buildMatchKey(entry.sourceNormalized, entry.occurrenceIndex),
      entry
    ])
  );
}

export function classifySegment(
  entryLookup: Map<string, TranslationEntry>,
  segment: PageSegment
): PreviewItem {
  const entry = entryLookup.get(
    buildMatchKey(segment.sourceNormalized, segment.occurrenceIndex)
  );

  if (!entry) {
    return {
      ...segment,
      status: 'unmatched',
      reason: 'No matching source row found in Excel.'
    };
  }

  if (!segment.isEmptyTarget) {
    return {
      ...segment,
      status: 'alreadyTranslated',
      translation: entry.targetRaw,
      excelRowIndex: entry.rowIndex,
      reason: 'Segment already has a translation.'
    };
  }

  if (!placeholdersMatch(segment.sourceRaw, entry.targetRaw)) {
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
  segments: PageSegment[]
): PreviewResult {
  const lookup = createEntryLookup(entries);
  const items = segments.map((segment) => classifySegment(lookup, segment));
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
  const unmatchedIndex = [...preview.items]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => item.status === 'unmatched')?.index;

  if (unmatchedIndex === undefined) {
    return preview;
  }

  const items = preview.items.filter((_, index) => index !== unmatchedIndex);
  return summarizePreview(items);
}
