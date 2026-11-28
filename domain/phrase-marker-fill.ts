import type { PhraseExportedTarget, PhraseNativeMarker } from '../shared/translation-types.ts';
import { normalizeText } from '../shared/utils.ts';
import { extractPlaceholderTokens } from './qa.ts';

export interface PhraseCellContent {
  text: string;
  markers: PhraseNativeMarker[];
}

export function isEmptyPhraseCell(cell: PhraseCellContent | null): boolean {
  return cell !== null && cell.markers.length === 0 && normalizeText(cell.text) === '';
}

export type PhraseTargetPart =
  | { type: 'text'; value: string }
  | { type: 'tag'; marker: PhraseNativeMarker };

export interface PhraseMarkerFillPlan {
  sourceMarkers: readonly PhraseNativeMarker[];
  parts: PhraseTargetPart[];
}

type Preparation =
  | { ok: true; plan: PhraseMarkerFillPlan }
  | { ok: false; reason: string };

interface TargetMarkerPosition {
  offset: number;
  marker: PhraseNativeMarker;
}

export function preparePhraseTranslation(
  source: string,
  sourceMarkers: readonly PhraseNativeMarker[],
  target: string,
  validatePlaceholders: boolean,
  exportedTarget?: PhraseExportedTarget
): Preparation {
  if (exportedTarget?.text === target) {
    const exportedPositions: TargetMarkerPosition[] = [];
    for (const { token, offset } of exportedTarget.markers) {
      const marker = sourceMarkers.find(item => item.token === token && target.startsWith(item.label, offset));
      if (!marker) return { ok: false, reason: 'An exported Phrase target marker no longer matches this source row.' };
      exportedPositions.push({ marker, offset });
    }
    return buildPlan(source, sourceMarkers, target, exportedPositions, validatePlaceholders);
  }

  const markersByLabel = new Map<string, PhraseNativeMarker[]>();
  for (const marker of sourceMarkers) {
    const markers = markersByLabel.get(marker.label) ?? [];
    markers.push(marker);
    markersByLabel.set(marker.label, markers);
  }

  // Every alternative comes from the current row. Resolve longer labels first
  // so a marker contained in another label is never mistaken for its own chip.
  const spellingPattern = new RegExp([...markersByLabel.keys()]
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'), 'g');

  const sourceMatches = [...source.matchAll(spellingPattern)];
  if (sourceMatches.length !== sourceMarkers.length || sourceMatches.some(
    (match, index) => match.index !== sourceMarkers[index].offset || match[0] !== sourceMarkers[index].label
  )) {
    return { ok: false, reason: 'A native Phrase marker cannot be distinguished from literal text in this source.' };
  }

  const targetMatches = [...target.matchAll(spellingPattern)];
  const targetCounts = new Map<string, number>();
  for (const [label] of targetMatches) {
    targetCounts.set(label, (targetCounts.get(label) ?? 0) + 1);
  }
  for (const [label, markers] of markersByLabel) {
    const count = targetCounts.get(label) ?? 0;
    if (count && count !== markers.length && new Set(markers.map(marker => marker.token)).size > 1) {
      return { ok: false, reason: `Target uses ${label} a different number of times and the source has multiple IDs for that label.` };
    }
  }

  const usedByLabel = new Map<string, number>();
  const positions = targetMatches.map((match) => {
    const label = match[0];
    const markers = markersByLabel.get(label)!;
    const used = usedByLabel.get(label) ?? 0;
    const marker = markers[Math.min(used, markers.length - 1)];
    usedByLabel.set(label, used + 1);

    return { marker, offset: match.index };
  });
  return buildPlan(source, sourceMarkers, target, positions, validatePlaceholders);
}

function buildPlan(
  source: string,
  sourceMarkers: readonly PhraseNativeMarker[],
  target: string,
  positions: readonly TargetMarkerPosition[],
  validatePlaceholders: boolean
): Preparation {
  const parts: PhraseTargetPart[] = [];
  let cursor = 0;
  for (const { marker, offset } of positions) {
    if (offset < cursor) return { ok: false, reason: 'Exported Phrase target markers overlap or are out of order.' };
    if (offset > cursor) parts.push({ type: 'text', value: target.slice(cursor, offset) });
    parts.push({ type: 'tag', marker });
    cursor = offset + marker.label.length;
  }
  if (cursor < target.length) parts.push({ type: 'text', value: target.slice(cursor) });

  if (validatePlaceholders) {
    const sourceLiterals = extractPhraseLiteralPlaceholders(source, sourceMarkers);
    const targetLiterals = parts.flatMap((part) => part.type === 'text' ? extractPlaceholderTokens(part.value) : []);
    if (sourceLiterals.length !== targetLiterals.length ||
      sourceLiterals.some((token, index) => token !== targetLiterals[index])) {
      return { ok: false, reason: 'Placeholder mismatch between Phrase source and translation.' };
    }
  }

  return { ok: true, plan: { sourceMarkers, parts } };
}

function extractPhraseLiteralPlaceholders(text: string, markers: readonly PhraseNativeMarker[]): string[] {
  const tokens: string[] = [];
  let offset = 0;
  for (const marker of markers) {
    tokens.push(...extractPlaceholderTokens(text.slice(offset, marker.offset)));
    offset = marker.offset + marker.label.length;
  }
  return tokens.concat(extractPlaceholderTokens(text.slice(offset)));
}

export function phraseTargetMatches(
  actual: PhraseCellContent,
  expected: readonly PhraseTargetPart[]
): boolean {
  let offset = 0;
  let markerIndex = 0;
  for (const part of expected) {
    const nextMarker = actual.markers[markerIndex];
    if (part.type === 'text') {
      const end = nextMarker?.offset ?? actual.text.length;
      if (actual.text.slice(offset, end) !== part.value) return false;
      offset = end;
    } else {
      const { id, token, label } = part.marker;
      if (nextMarker?.offset !== offset || nextMarker.id !== id || nextMarker.token !== token || nextMarker.label !== label) {
        return false;
      }
      offset += label.length;
      markerIndex += 1;
    }
  }
  return offset === actual.text.length && markerIndex === actual.markers.length;
}
