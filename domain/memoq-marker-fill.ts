import type { PageSegment, TranslationEntry } from '../shared/translation-types.ts';
import { normalizeText } from '../shared/utils.ts';
import { findForeignMemoqTagInPlainRow, maskMemoqMarkers } from './memoq-file-tags.ts';
import { mapMemoqTarget } from './memoq-marker-mapping.ts';
import { hasMemoqInlineTagMarkup, memoqProtectedSourceMatchesExcelSource } from './memoq-markup.ts';
import { placeholdersMatch } from './qa.ts';

const ANCHOR_CODE_POINT_START = 0xe000;
const ANCHOR_CODE_POINT_END = 0xf8ff;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: 'grapheme'
});

export interface MemoqMarkerAnchor {
  sentinel: string;
  markers: string[];
}

export interface MemoqSequentialMarkerPlan {
  method: 'f9';
  expectedTarget: string;
  skeletonTarget: string;
  anchors: MemoqMarkerAnchor[];
}

export type MemoqMarkerFillPlan =
  | { method: 'webtrans'; expectedTarget: string }
  | MemoqSequentialMarkerPlan;

export type MemoqMarkerFillPlanResult =
  | {
      ok: true;
      plan: MemoqMarkerFillPlan;
    }
  | {
      ok: false;
      reason: string;
    };

/** Used by both Preview and Fill. Only the fill runner keeps the prepared plan. */
export function prepareMemoqTranslation(
  entry: TranslationEntry, segment: PageSegment, validatePlaceholders: boolean
): { ok: true; plan?: MemoqMarkerFillPlan } | { ok: false; reason: string } {
  let source = segment.sourceRaw;
  let target = entry.targetRaw;
  let plan: MemoqMarkerFillPlan | undefined;
  if (segment.memoqSourceMarkers?.length === 0) {
    const foreign = findForeignMemoqTagInPlainRow(source, target);
    if (foreign) return { ok: false, reason: `Target tag ${foreign} is absent from this source row.` };
  } else if (hasMemoqInlineTagMarkup(source)) {
    const result = createMemoqMarkerFillPlan(entry.sourceRaw, source, target,
      segment.originalSource ?? entry.originalSource, segment.memoqSourceMarkers);
    if (!result.ok) {
      return segment.memoqSourceMarkers ? result
        : { ok: false, reason: `memoQ marker fill is not safe for this row: ${result.reason}` };
    }
    plan = result.plan;
    target = plan.expectedTarget;
    if (plan.method === 'webtrans') {
      source = maskMemoqMarkers(source);
      target = maskMemoqMarkers(target);
    } else if (validatePlaceholders && normalizeText(entry.sourceNormalized) !== normalizeText(segment.sourceNormalized) &&
      memoqProtectedSourceMatchesExcelSource(source, entry.sourceRaw)) {
      // The sequential plan already checked every protected file token in order.
      return result;
    }
  }
  if (validatePlaceholders && !placeholdersMatch(source, target, 'memoq', segment.placeholderTokens)) {
    return { ok: false, reason: 'Placeholder mismatch between source and translation.' };
  }
  return { ok: true, plan };
}

/** webTrans takes the complete target. Only sequential F9 needs cursor anchors. */
export function createMemoqMarkerFillPlan(
  excelSource: string,
  memoqSource: string,
  excelTarget: string,
  originalSource?: string,
  webTransMarkers?: readonly string[]
): MemoqMarkerFillPlanResult {
  const mapping = mapMemoqTarget(excelSource, memoqSource, excelTarget, originalSource, webTransMarkers);
  if (!mapping.ok) {
    return mapping;
  }

  const expectedTarget = mapping.parts.map(part =>
    part.type === 'text' ? part.text : part.markers.join('')
  ).join('');
  if (webTransMarkers !== undefined) {
    return { ok: true, plan: { method: 'webtrans', expectedTarget } };
  }

  const sentinels = allocateAnchorSentinels(
    mapping.parts.filter((part) => part.type === 'markers').length,
    `${excelSource}${memoqSource}${excelTarget}`
  );
  if (!sentinels) {
    return { ok: false, reason: 'No safe private-use marker anchors are available.' };
  }

  const skeletonParts: string[] = [];
  const anchors: MemoqMarkerAnchor[] = [];
  for (const part of mapping.parts) {
    if (part.type === 'text') {
      skeletonParts.push(part.text);
      continue;
    }

    const sentinel = sentinels[anchors.length];
    skeletonParts.push(sentinel);
    anchors.push({ sentinel, markers: part.markers });
  }

  return {
    ok: true,
    plan: {
      method: 'f9',
      expectedTarget,
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
