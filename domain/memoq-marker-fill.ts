import { normalizeText } from '../shared/utils.ts';

const EXCEL_MARKUP_PATTERN =
  /\{[^{}<>]+\}|<\/>|<\/[A-Za-z][^<>]*>|<[A-Za-z][^<>]*\/?>/g;
const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;
const SKELETON_TOKEN = '\ufffc';
const ANCHOR_CODE_POINT_START = 0xe000;
const ANCHOR_CODE_POINT_END = 0xf8ff;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme'
});

type MarkerKind = 'empty' | 'open' | 'close';

interface TokenSpan {
  token: string;
  start: number;
  end: number;
  kind: MarkerKind;
}

export interface MemoqMarkerAnchor {
  sentinel: string;
  markers: string[];
}

export interface MemoqMarkerFillPlan {
  expectedTarget: string;
  skeletonTarget: string;
  anchors: MemoqMarkerAnchor[];
}

export type MemoqMarkerFillPlanResult =
  | {
      ok: true;
      plan: MemoqMarkerFillPlan;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Builds a marker-agnostic target skeleton. Excel placeholders and XML-like
 * paired tags become private-use sentinels that can later be replaced with
 * memoQ's native marker sequences through deterministic editor navigation.
 */
export function createMemoqMarkerFillPlan(
  excelSource: string,
  memoqSource: string,
  excelTarget: string
): MemoqMarkerFillPlanResult {
  const sourcePlaceholders = collectExcelTokenSpans(
    excelSource,
    EXCEL_MARKUP_PATTERN
  );
  const memoqMarkers = collectMemoqTokenSpans(
    memoqSource,
    MEMOQ_MARKER_PATTERN
  );
  const targetPlaceholders = collectExcelTokenSpans(
    excelTarget,
    EXCEL_MARKUP_PATTERN
  );

  if (sourcePlaceholders.length === 0 || memoqMarkers.length === 0) {
    return failure('The source does not expose a placeholder-to-marker mapping.');
  }

  if (sourcePlaceholders.length !== memoqMarkers.length) {
    return failure('Excel source placeholders and memoQ source markers have different counts.');
  }

  if (
    buildSkeleton(excelSource, EXCEL_MARKUP_PATTERN) !==
    buildSkeleton(memoqSource, MEMOQ_MARKER_PATTERN)
  ) {
    return failure('Excel placeholders cannot be aligned exactly with memoQ source markers.');
  }

  const sourceTokens = sourcePlaceholders.map(({ token }) => token);
  const targetTokens = targetPlaceholders.map(({ token }) => token);
  if (!arraysEqual(sourceTokens, targetTokens)) {
    return failure('Target placeholders must preserve the source placeholder order.');
  }

  const sourceKinds = sourcePlaceholders.map(({ kind }) => kind);
  const memoqKinds = memoqMarkers.map(({ kind }) => kind);
  const targetKinds = targetPlaceholders.map(({ kind }) => kind);
  if (
    !arraysEqual(sourceKinds, memoqKinds) ||
    !arraysEqual(sourceKinds, targetKinds)
  ) {
    return failure('Excel markup types do not match memoQ marker types.');
  }

  if (
    !hasBalancedPairedMarkup(sourcePlaceholders) ||
    !hasBalancedPairedMarkup(targetPlaceholders)
  ) {
    return failure('Paired Excel markup is not balanced safely.');
  }

  const sourceGroupSizes = collectAdjacentGroupSizes(sourcePlaceholders);
  const memoqGroupSizes = collectAdjacentGroupSizes(memoqMarkers);
  const targetGroupSizes = collectAdjacentGroupSizes(targetPlaceholders);
  if (
    !arraysEqual(sourceGroupSizes, memoqGroupSizes) ||
    !arraysEqual(memoqGroupSizes, targetGroupSizes)
  ) {
    return failure('Target placeholder grouping does not match memoQ marker sequences.');
  }

  const sentinels = allocateAnchorSentinels(
    targetGroupSizes.length,
    `${excelSource}${memoqSource}${excelTarget}`
  );
  if (!sentinels) {
    return failure('No safe private-use marker anchors are available.');
  }

  const skeletonParts: string[] = [];
  const expectedParts: string[] = [];
  const anchors: MemoqMarkerAnchor[] = [];
  let targetCursor = 0;
  let tokenCursor = 0;

  for (let groupIndex = 0; groupIndex < targetGroupSizes.length; groupIndex += 1) {
    const groupSize = targetGroupSizes[groupIndex] ?? 0;
    const firstPlaceholder = targetPlaceholders[tokenCursor];
    const lastPlaceholder = targetPlaceholders[tokenCursor + groupSize - 1];
    const markers = memoqMarkers
      .slice(tokenCursor, tokenCursor + groupSize)
      .map(({ token }) => token);
    const sentinel = sentinels[groupIndex];
    if (
      !groupSize ||
      !firstPlaceholder ||
      !lastPlaceholder ||
      markers.length !== groupSize ||
      !sentinel
    ) {
      return failure('Target marker anchors could not be resolved safely.');
    }

    const text = excelTarget.slice(targetCursor, firstPlaceholder.start);
    skeletonParts.push(text, sentinel);
    expectedParts.push(text, markers.join(''));
    anchors.push({ sentinel, markers });
    targetCursor = lastPlaceholder.end;
    tokenCursor += groupSize;
  }

  const suffix = excelTarget.slice(targetCursor);
  skeletonParts.push(suffix);
  expectedParts.push(suffix);

  return {
    ok: true,
    plan: {
      expectedTarget: expectedParts.join(''),
      skeletonTarget: skeletonParts.join(''),
      anchors
    }
  };
}

/**
 * Counts editor cursor atoms before one unique skeleton sentinel. The caller
 * adds the expansion from earlier multi-marker sequences after this base
 * offset is calculated from the immutable skeleton.
 */
export function countMemoqCursorUnitsBeforeAnchor(
  value: string,
  sentinel: string
): number | null {
  const anchorIndex = value.indexOf(sentinel);
  if (
    anchorIndex < 0 ||
    value.indexOf(sentinel, anchorIndex + sentinel.length) >= 0
  ) {
    return null;
  }

  return countGraphemeClusters(value.slice(0, anchorIndex));
}

function collectExcelTokenSpans(
  value: string,
  pattern: RegExp
): TokenSpan[] {
  return collectTokenSpans(value, pattern, classifyExcelToken);
}

function collectMemoqTokenSpans(
  value: string,
  pattern: RegExp
): TokenSpan[] {
  return collectTokenSpans(value, pattern, classifyMemoqToken);
}

function collectTokenSpans(
  value: string,
  pattern: RegExp,
  classify: (token: string) => MarkerKind
): TokenSpan[] {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    (match) => {
      const start = match.index ?? 0;
      return {
        token: match[0],
        start,
        end: start + match[0].length,
        kind: classify(match[0])
      };
    }
  );
}

function classifyExcelToken(token: string): MarkerKind {
  if (token.startsWith('{')) {
    return 'empty';
  }

  if (token.startsWith('</')) {
    return 'close';
  }

  return token.endsWith('/>') ? 'empty' : 'open';
}

function classifyMemoqToken(token: string): MarkerKind {
  if (token.startsWith('{')) {
    return 'open';
  }

  return token.endsWith('}') ? 'close' : 'empty';
}

function hasBalancedPairedMarkup(spans: TokenSpan[]): boolean {
  let depth = 0;

  for (const span of spans) {
    if (span.kind === 'open') {
      depth += 1;
      continue;
    }

    if (span.kind === 'close') {
      if (depth === 0) {
        return false;
      }
      depth -= 1;
    }
  }

  return depth === 0;
}

function buildSkeleton(value: string, pattern: RegExp): string {
  return normalizeText(
    value.replace(new RegExp(pattern.source, pattern.flags), SKELETON_TOKEN)
  );
}

function collectAdjacentGroupSizes(spans: TokenSpan[]): number[] {
  const sizes: number[] = [];
  let currentSize = 0;
  let previousEnd: number | null = null;

  for (const span of spans) {
    if (previousEnd === null || span.start === previousEnd) {
      currentSize += 1;
    } else {
      sizes.push(currentSize);
      currentSize = 1;
    }
    previousEnd = span.end;
  }

  if (currentSize > 0) {
    sizes.push(currentSize);
  }

  return sizes;
}

function allocateAnchorSentinels(count: number, occupied: string): string[] | null {
  const sentinels: string[] = [];

  for (
    let codePoint = ANCHOR_CODE_POINT_START;
    codePoint <= ANCHOR_CODE_POINT_END && sentinels.length < count;
    codePoint += 1
  ) {
    const candidate = String.fromCodePoint(codePoint);
    if (!occupied.includes(candidate)) {
      sentinels.push(candidate);
    }
  }

  return sentinels.length === count ? sentinels : null;
}

function countGraphemeClusters(value: string): number {
  return Array.from(GRAPHEME_SEGMENTER.segment(value)).length;
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function failure(reason: string): MemoqMarkerFillPlanResult {
  return { ok: false, reason };
}
