import { normalizeText } from '../shared/utils.ts';

const MEMOQ_INLINE_TAG_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;
const MAX_PROTECTED_TEXT_LENGTH_PER_TAG = 256;

interface MemoqProtectedSourcePattern {
  anchors: string[];
  tagGroupSizes: number[];
}

export function hasMemoqInlineTagMarkup(value: string): boolean {
  return /\{\d+>|<\d+\}|<\d+>/.test(value);
}

/**
 * Compares an Excel source with memoQ's rendered source without needing to
 * know how memoQ encoded each protected span. Visible text must remain exact;
 * only serialized memoQ inline-tag positions may consume source-file text.
 */
export function memoqProtectedSourceMatchesExcelSource(
  memoqSource: string,
  excelSource: string
): boolean {
  const normalizedMemoqSource = normalizeText(memoqSource);
  const normalizedExcelSource = normalizeText(excelSource);

  if (normalizedMemoqSource === normalizedExcelSource) {
    return true;
  }

  const pattern = parseMemoqProtectedSourcePattern(normalizedMemoqSource);
  if (!pattern) {
    return false;
  }

  const firstAnchor = pattern.anchors[0] ?? '';
  if (!normalizedExcelSource.startsWith(firstAnchor)) {
    return false;
  }

  return matchProtectedSourceFrom(
    pattern,
    normalizedExcelSource,
    0,
    firstAnchor.length,
    new Set<string>()
  );
}

function parseMemoqProtectedSourcePattern(
  value: string
): MemoqProtectedSourcePattern | null {
  const anchors: string[] = [];
  const tagGroupSizes: number[] = [];
  let cursor = 0;
  let pendingTagCount = 0;

  for (const match of value.matchAll(MEMOQ_INLINE_TAG_PATTERN)) {
    const index = match.index ?? 0;
    const visibleText = value.slice(cursor, index);

    if (anchors.length === 0) {
      anchors.push(visibleText);
    } else if (visibleText) {
      tagGroupSizes.push(pendingTagCount);
      anchors.push(visibleText);
      pendingTagCount = 0;
    }

    pendingTagCount += 1;
    cursor = index + match[0].length;
  }

  if (pendingTagCount === 0) {
    return null;
  }

  tagGroupSizes.push(pendingTagCount);
  anchors.push(value.slice(cursor));

  return {
    anchors,
    tagGroupSizes
  };
}

function matchProtectedSourceFrom(
  pattern: MemoqProtectedSourcePattern,
  excelSource: string,
  gapIndex: number,
  excelCursor: number,
  failedStates: Set<string>
): boolean {
  if (gapIndex >= pattern.tagGroupSizes.length) {
    return excelCursor === excelSource.length;
  }

  const stateKey = `${gapIndex}:${excelCursor}`;
  if (failedStates.has(stateKey)) {
    return false;
  }

  const tagGroupSize = pattern.tagGroupSizes[gapIndex] ?? 1;
  const minGapLength = 1;
  const maxGapLength =
    tagGroupSize * MAX_PROTECTED_TEXT_LENGTH_PER_TAG;
  const nextAnchor = pattern.anchors[gapIndex + 1] ?? '';
  const isFinalGap = gapIndex === pattern.tagGroupSizes.length - 1;

  if (isFinalGap) {
    const anchorStart = excelSource.length - nextAnchor.length;
    const gapLength = anchorStart - excelCursor;

    if (
      gapLength >= minGapLength &&
      gapLength <= maxGapLength &&
      anchorStart >= excelCursor &&
      excelSource.startsWith(nextAnchor, anchorStart)
    ) {
      return true;
    }

    failedStates.add(stateKey);
    return false;
  }

  const earliestAnchorStart = excelCursor + minGapLength;
  const latestAnchorStart = Math.min(
    excelCursor + maxGapLength,
    excelSource.length - nextAnchor.length
  );
  let anchorStart = excelSource.indexOf(nextAnchor, earliestAnchorStart);

  while (anchorStart !== -1 && anchorStart <= latestAnchorStart) {
    if (
      matchProtectedSourceFrom(
        pattern,
        excelSource,
        gapIndex + 1,
        anchorStart + nextAnchor.length,
        failedStates
      )
    ) {
      return true;
    }

    anchorStart = excelSource.indexOf(nextAnchor, anchorStart + 1);
  }

  failedStates.add(stateKey);
  return false;
}
