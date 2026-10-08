import { mapMemoqTarget } from './memoq-marker-mapping.ts';

const ANCHOR_CODE_POINT_START = 0xe000;
const ANCHOR_CODE_POINT_END = 0xf8ff;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme'
});

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

/** Compile validated text/tag parts for the existing sentinel-based editor writer. */
export function createMemoqMarkerFillPlan(
  excelSource: string,
  memoqSource: string,
  excelTarget: string
): MemoqMarkerFillPlanResult {
  const mapping = mapMemoqTarget(excelSource, memoqSource, excelTarget);
  if (!mapping.ok) {
    return mapping;
  }

  const sentinels = allocateAnchorSentinels(
    mapping.parts.filter((part) => part.type === 'markers').length,
    `${excelSource}${memoqSource}${excelTarget}`
  );
  if (!sentinels) {
    return { ok: false, reason: 'No safe private-use marker anchors are available.' };
  }

  const skeletonParts: string[] = [];
  const expectedParts: string[] = [];
  const anchors: MemoqMarkerAnchor[] = [];
  for (const part of mapping.parts) {
    if (part.type === 'text') {
      skeletonParts.push(part.text);
      expectedParts.push(part.text);
      continue;
    }

    const sentinel = sentinels[anchors.length];
    skeletonParts.push(sentinel);
    expectedParts.push(part.markers.join(''));
    anchors.push({ sentinel, markers: part.markers });
  }

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

function allocateAnchorSentinels(count: number, occupied: string): string[] | null {
  const sentinels: string[] = [];
  const occupiedCharacters = new Set(occupied);

  for (
    let codePoint = ANCHOR_CODE_POINT_START;
    codePoint <= ANCHOR_CODE_POINT_END && sentinels.length < count;
    codePoint += 1
  ) {
    const candidate = String.fromCodePoint(codePoint);
    if (!occupiedCharacters.has(candidate)) {
      sentinels.push(candidate);
    }
  }

  return sentinels.length === count ? sentinels : null;
}

function countGraphemeClusters(value: string): number {
  return Array.from(GRAPHEME_SEGMENTER.segment(value)).length;
}
