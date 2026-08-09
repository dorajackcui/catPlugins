import { normalizeText } from '../shared/utils.ts';

const EXCEL_PLACEHOLDER_PATTERN = /\{[^{}<>]+\}/g;
const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;
const MEMOQ_EMPTY_MARKER_PATTERN = /^<\d+>$/;
const SKELETON_TOKEN = '\ufffc';

interface TokenSpan {
  token: string;
  start: number;
  end: number;
}

export type MemoqMarkerFillOperation =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'markerSequence';
      markers: string[];
    };

export interface MemoqMarkerFillPlan {
  expectedTarget: string;
  markerCount: number;
  markerSequenceCount: number;
  operations: MemoqMarkerFillOperation[];
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
 * Builds the deliberately narrow first version of memoQ native-marker fill.
 * It supports empty markers only and requires source/target placeholder order
 * plus adjacent-sequence grouping to remain unchanged.
 */
export function createMemoqMarkerFillPlan(
  excelSource: string,
  memoqSource: string,
  excelTarget: string
): MemoqMarkerFillPlanResult {
  const sourcePlaceholders = collectTokenSpans(
    excelSource,
    EXCEL_PLACEHOLDER_PATTERN
  );
  const memoqMarkers = collectTokenSpans(memoqSource, MEMOQ_MARKER_PATTERN);
  const targetPlaceholders = collectTokenSpans(
    excelTarget,
    EXCEL_PLACEHOLDER_PATTERN
  );

  if (sourcePlaceholders.length === 0 || memoqMarkers.length === 0) {
    return failure('The source does not expose a placeholder-to-marker mapping.');
  }

  if (memoqMarkers.some(({ token }) => !MEMOQ_EMPTY_MARKER_PATTERN.test(token))) {
    return failure('Paired memoQ markers are not supported by the experimental path yet.');
  }

  if (sourcePlaceholders.length !== memoqMarkers.length) {
    return failure('Excel source placeholders and memoQ source markers have different counts.');
  }

  if (
    buildSkeleton(excelSource, EXCEL_PLACEHOLDER_PATTERN) !==
    buildSkeleton(memoqSource, MEMOQ_MARKER_PATTERN)
  ) {
    return failure('Excel placeholders cannot be aligned exactly with memoQ source markers.');
  }

  const sourceTokens = sourcePlaceholders.map(({ token }) => token);
  const targetTokens = targetPlaceholders.map(({ token }) => token);
  if (!arraysEqual(sourceTokens, targetTokens)) {
    return failure('Target placeholders must preserve the source placeholder order.');
  }

  const markerGroupSizes = collectAdjacentGroupSizes(memoqMarkers);
  const targetGroupSizes = collectAdjacentGroupSizes(targetPlaceholders);
  if (!arraysEqual(markerGroupSizes, targetGroupSizes)) {
    return failure('Target placeholder grouping does not match memoQ marker sequences.');
  }

  const operations: MemoqMarkerFillOperation[] = [];
  let targetCursor = 0;
  let markerCursor = 0;
  let placeholderCursor = 0;

  for (const groupSize of targetGroupSizes) {
    const firstPlaceholder = targetPlaceholders[placeholderCursor];
    const lastPlaceholder = targetPlaceholders[placeholderCursor + groupSize - 1];
    if (!firstPlaceholder || !lastPlaceholder) {
      return failure('Target placeholder grouping could not be resolved safely.');
    }

    appendTextOperation(
      operations,
      excelTarget.slice(targetCursor, firstPlaceholder.start)
    );
    operations.push({
      type: 'markerSequence',
      markers: memoqMarkers
        .slice(markerCursor, markerCursor + groupSize)
        .map(({ token }) => token)
    });

    targetCursor = lastPlaceholder.end;
    markerCursor += groupSize;
    placeholderCursor += groupSize;
  }

  appendTextOperation(operations, excelTarget.slice(targetCursor));

  return {
    ok: true,
    plan: {
      expectedTarget: operations
        .map((operation) =>
          operation.type === 'text'
            ? operation.text
            : operation.markers.join('')
        )
        .join(''),
      markerCount: memoqMarkers.length,
      markerSequenceCount: markerGroupSizes.length,
      operations
    }
  };
}

function collectTokenSpans(value: string, pattern: RegExp): TokenSpan[] {
  return [...value.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    (match) => {
      const start = match.index ?? 0;
      return {
        token: match[0],
        start,
        end: start + match[0].length
      };
    }
  );
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

function appendTextOperation(
  operations: MemoqMarkerFillOperation[],
  text: string
): void {
  if (text) {
    operations.push({ type: 'text', text });
  }
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
