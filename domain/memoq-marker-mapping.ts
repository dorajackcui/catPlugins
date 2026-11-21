import { normalizeText } from '../shared/utils.ts';
import {
  EXCEL_MARKUP_PATTERN,
  FILE_MARKUP,
  MEMOQ_MARKER_PATTERN,
  readLiteralMemoqTags,
  readMemoqTagSpans,
  resolveExcelMarkerPattern,
  type MemoqTagSpan
} from './memoq-file-tags.ts';

/** Translation content independent of sentinels, cursor movement, and editor input. */
export type MemoqTargetPart =
  | { type: 'text'; text: string }
  | { type: 'markers'; markers: string[] };

export type MemoqTargetMappingResult =
  | { ok: true; parts: MemoqTargetPart[] }
  | { ok: false; reason: string };

export function needsMemoqOriginalTags(entry: { sourceRaw: string; targetRaw: string; originalSource?: string }): boolean {
  if (entry.originalSource || entry.targetRaw.search(FILE_MARKUP) === -1) return false;
  const native = entry.sourceRaw.match(MEMOQ_MARKER_PATTERN);
  return native !== null && !arraysEqual(native, entry.targetRaw.match(MEMOQ_MARKER_PATTERN) ?? []);
}

/** Source chip IDs are supplied only by webTrans editors accepting a complete tagged target. */
export function mapMemoqTarget(
  excelSource: string,
  memoqSource: string,
  excelTarget: string,
  originalSource?: string,
  webTransMarkers?: readonly string[]
): MemoqTargetMappingResult {
  if (webTransMarkers && !arraysEqual(webTransMarkers, memoqSource.match(MEMOQ_MARKER_PATTERN) ?? [])) {
    return failure('The marker notation in this source does not identify its native chips unambiguously.');
  }
  const nativeSource = normalizeText(excelSource) === normalizeText(memoqSource);
  if (!nativeSource && originalSource && normalizeText(originalSource) !== normalizeText(excelSource)) {
    return failure('The original Excel source differs from the recorded memoQ file tags.');
  }
  const byId = webTransMarkers !== undefined;
  const direct = mapMatchingNotation(excelSource, memoqSource, excelTarget, byId);
  if (direct.ok) return direct;

  if (nativeSource) {
    if (originalSource && originalSource !== excelSource) {
      const original = mapMatchingNotation(originalSource, memoqSource, excelTarget, byId);
      if (original.ok) return original;
    }
    if (!byId && !originalSource && needsMemoqOriginalTags({ sourceRaw: excelSource, targetRaw: excelTarget })) {
      return failure('This short-tag source needs the originalSource column from Export to match file tags in the target.');
    }
    return direct;
  }
  // A native target still requires the Excel source to align with this row.
  if (!excelTarget.match(MEMOQ_MARKER_PATTERN)) return direct;
  const sourceCheck = mapMatchingNotation(excelSource, memoqSource, excelSource, byId);
  return sourceCheck.ok ? mapMatchingNotation(memoqSource, memoqSource, excelTarget, byId) : sourceCheck;
}

function mapMatchingNotation(
  excelSource: string,
  memoqSource: string,
  excelTarget: string,
  byId: boolean
): MemoqTargetMappingResult {
  // Some import filters protect only line breaks and keep ${1}, %{name},
  // and XML-like markup literal. Derive the mapping from the actual source;
  // literal tokens must not count as native tags or join their F9 groups.
  const matchedPattern = resolveExcelMarkerPattern(memoqSource, excelSource, byId);
  // On mismatch, retain the old diagnostic precedence; this fallback never
  // authorizes a write because unmatched sources are rejected below.
  const excelMarkerPattern = matchedPattern ?? EXCEL_MARKUP_PATTERN;
  const sourcePlaceholders = readMemoqTagSpans(excelSource, excelMarkerPattern);
  const memoqMarkers = readMemoqTagSpans(memoqSource, MEMOQ_MARKER_PATTERN);
  const targetPlaceholders = readMemoqTagSpans(excelTarget, excelMarkerPattern);

  if (sourcePlaceholders.length === 0 || memoqMarkers.length === 0) {
    return failure('The source does not expose a placeholder-to-marker mapping.');
  }

  if (sourcePlaceholders.length !== memoqMarkers.length) {
    return failure('Excel source placeholders and memoQ source markers have different counts.');
  }

  if (!matchedPattern) {
    return failure('Excel placeholders cannot be aligned exactly with memoQ source markers.');
  }

  const sourceTokens = sourcePlaceholders.map(({ token }) => token);
  const targetTokens = targetPlaceholders.map(({ token }) => token);
  const sameTokenOrder = arraysEqual(sourceTokens, targetTokens);
  if (!byId && !sameTokenOrder) {
    return failure('Target placeholders must preserve the source placeholder order.');
  }

  // The other notation may occur as literal game text. Only its original
  // literal tokens may survive outside the spans used for native insertion.
  const sourceLiteral = readLiteralMemoqTags(excelSource, excelMarkerPattern, byId);
  const targetLiteral = readLiteralMemoqTags(excelTarget, excelMarkerPattern, byId);
  if (!arraysEqual(sourceLiteral, targetLiteral)) {
    const foreign = byId && targetLiteral.find(token => !sourceLiteral.includes(token));
    if (foreign) return failure('Target tag ' + foreign + ' is absent from this source row.');
    return failure('The target mixes native markers and file tags or changes a literal placeholder.');
  }

  if (!byId && !sourcePlaceholders.every((span, index) =>
    memoqMarkers[index].kind === 'empty' || span.kind === memoqMarkers[index].kind
  )) {
    return failure('Excel markup types do not match memoQ marker types.');
  }

  // Sequential insertion relies on balanced source pairs. For direct ID
  // insertion each target occurrence will be resolved independently below.
  if (!byId && excelMarkerPattern !== MEMOQ_MARKER_PATTERN && !hasBalancedPairedMarkup(sourcePlaceholders)) {
    return failure('Paired Excel markup is not balanced safely.');
  }

  const sourceGroupSizes = collectAdjacentGroupSizes(sourcePlaceholders);
  const memoqGroupSizes = collectAdjacentGroupSizes(memoqMarkers);
  if (
    !arraysEqual(sourceGroupSizes, memoqGroupSizes) ||
    (!byId && !arraysEqual(memoqGroupSizes, collectAdjacentGroupSizes(targetPlaceholders)))
  ) {
    return failure('Target placeholder grouping does not match memoQ marker sequences.');
  }

  const nativeTokens = memoqMarkers.map(({ token }) => token);
  // Keeping the occurrence order also preserves otherwise indistinguishable
  // original labels that the editor assigned different native IDs.
  if (sameTokenOrder) {
    return buildTargetParts(excelTarget, targetPlaceholders, nativeTokens);
  }
  const idsByToken = new Map<string, Set<string>>();
  sourceTokens.forEach((token, index) => {
    const ids = idsByToken.get(token) ?? new Set<string>();
    ids.add(nativeTokens[index]);
    idsByToken.set(token, ids);
  });
  const targetMarkers: string[] = [];
  for (const token of targetTokens) {
    const ids = idsByToken.get(token);
    if (!ids) return failure('Target tag ' + token + ' is absent from this source row.');
    if (ids.size !== 1) return failure('Original tag ' + token + ' has multiple native IDs in this row. Use the short-tag export to distinguish them.');
    targetMarkers.push(...ids);
  }
  return buildTargetParts(excelTarget, targetPlaceholders, targetMarkers);
}

function buildTargetParts(target: string, spans: MemoqTagSpan[], markers: string[]): MemoqTargetMappingResult {
  const parts: MemoqTargetPart[] = [];
  let cursor = 0;
  for (const [i, span] of spans.entries()) {
    if (span.start > cursor) parts.push({ type: 'text', text: target.slice(cursor, span.start) });
    const previous = parts.at(-1);
    if (previous?.type === 'markers') previous.markers.push(markers[i]);
    else parts.push({ type: 'markers', markers: [markers[i]] });
    cursor = span.end;
  }

  const suffix = target.slice(cursor);
  if (suffix) {
    parts.push({ type: 'text', text: suffix });
  }
  return { ok: true, parts };
}

function hasBalancedPairedMarkup(spans: MemoqTagSpan[]): boolean {
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

function collectAdjacentGroupSizes(spans: MemoqTagSpan[]): number[] {
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

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function failure(reason: string): MemoqTargetMappingResult {
  return { ok: false, reason };
}
