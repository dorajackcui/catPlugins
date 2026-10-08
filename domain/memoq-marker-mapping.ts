import { normalizeText } from '../shared/utils.ts';

const EXCEL_MARKUP_PATTERN =
  /\{[^{}<>]+\}|<\/>|<\/[A-Za-z][^<>]*>|<[A-Za-z][^<>]*\/?>|\r\n|[\r\n]/g;
const EXCEL_LINE_BREAK_PATTERN = /\r\n|[\r\n]/g;
const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;
const SKELETON_TOKEN = '\ufffc';

type MarkerKind = 'empty' | 'open' | 'close';

interface TokenSpan {
  token: string;
  start: number;
  end: number;
  kind: MarkerKind;
}

/** Translation content independent of sentinels, cursor movement, and editor input. */
export type MemoqTargetPart =
  | { type: 'text'; text: string }
  | { type: 'markers'; markers: string[] };

export type MemoqTargetMappingResult =
  | { ok: true; parts: MemoqTargetPart[] }
  | { ok: false; reason: string };

/** Resolve the supported source mapping, then validate native tag order and groups. */
export function mapMemoqTarget(
  excelSource: string,
  memoqSource: string,
  excelTarget: string
): MemoqTargetMappingResult {
  // Some import filters protect only line breaks and keep ${1}, %{name},
  // and XML-like markup literal. Derive the mapping from the actual source;
  // literal tokens must not count as native tags or join their F9 groups.
  const matchedPattern = resolveExcelMarkerPattern(memoqSource, excelSource);
  // On mismatch, retain the old diagnostic precedence; this fallback never
  // authorizes a write because unmatched sources are rejected below.
  const excelMarkerPattern = matchedPattern ?? EXCEL_MARKUP_PATTERN;
  const sourcePlaceholders = collectExcelTokenSpans(
    excelSource,
    excelMarkerPattern
  );
  const memoqMarkers = collectTokenSpans(
    memoqSource,
    MEMOQ_MARKER_PATTERN,
    classifyMemoqToken
  );
  const targetPlaceholders = collectExcelTokenSpans(
    excelTarget,
    excelMarkerPattern
  );

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
  if (!arraysEqual(sourceTokens, targetTokens)) {
    return failure('Target placeholders must preserve the source placeholder order.');
  }

  const sourceKinds = sourcePlaceholders.map(({ kind }) => kind);
  const memoqKinds = memoqMarkers.map(({ kind }) => kind);
  if (!memoqMarkerKindsPreserveExcelOrder(sourceKinds, memoqKinds)) {
    return failure('Excel markup types do not match memoQ marker types.');
  }

  // Equal token sequences above also guarantee equal target kinds/balance.
  if (!hasBalancedPairedMarkup(sourcePlaceholders)) {
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

  const parts: MemoqTargetPart[] = [];
  let targetCursor = 0;
  let tokenCursor = 0;

  for (const groupSize of targetGroupSizes) {
    const firstPlaceholder = targetPlaceholders[tokenCursor];
    const lastPlaceholder = targetPlaceholders[tokenCursor + groupSize - 1];
    const markers = memoqMarkers.slice(tokenCursor, tokenCursor + groupSize)
      .map(({ token }) => token);
    if (!groupSize || !firstPlaceholder || !lastPlaceholder || markers.length !== groupSize) {
      return failure('Target marker anchors could not be resolved safely.');
    }

    const text = excelTarget.slice(targetCursor, firstPlaceholder.start);
    if (text) {
      parts.push({ type: 'text', text });
    }
    parts.push({ type: 'markers', markers });
    targetCursor = lastPlaceholder.end;
    tokenCursor += groupSize;
  }

  const suffix = excelTarget.slice(targetCursor);
  if (suffix) {
    parts.push({ type: 'text', text: suffix });
  }
  return { ok: true, parts };
}

function collectExcelTokenSpans(
  value: string,
  pattern: RegExp
): TokenSpan[] {
  return collectTokenSpans(value, pattern, classifyExcelToken).map((span) => ({
    ...span,
    // Compare logical breaks across Excel line endings, retaining raw offsets
    // so CRLF is replaced as one marker without leaving a carriage return.
    token: isLineBreak(span.token) ? '\n' : span.token
  }));
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
  if (token.startsWith('{') || isLineBreak(token)) {
    return 'empty';
  }

  if (token.startsWith('</')) {
    return 'close';
  }

  return token.endsWith('/>') ? 'empty' : 'open';
}

function isLineBreak(token: string): boolean {
  return token === '\n' || token === '\r\n' || token === '\r';
}

function classifyMemoqToken(token: string): MarkerKind {
  if (token.startsWith('{')) {
    return 'open';
  }

  return token.endsWith('}') ? 'close' : 'empty';
}

/**
 * memoQ webTrans can import XML-like pairs as two independent inline-empty
 * markers. That flattening is safe here because exact token order, visible
 * text, adjacency groups, and the balanced Excel source/target structure are
 * validated separately. A non-empty memoQ marker must still retain its Excel
 * marker kind.
 */
function memoqMarkerKindsPreserveExcelOrder(
  excelKinds: MarkerKind[],
  memoqKinds: MarkerKind[]
): boolean {
  return (
    excelKinds.length === memoqKinds.length &&
    excelKinds.every(
      (excelKind, index) =>
        memoqKinds[index] === excelKind || memoqKinds[index] === 'empty'
    )
  );
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

/** Replace protected spans before whitespace normalization can erase breaks. */
export function memoqSourceSkeletonMatchesExcelSource(
  memoqSource: string,
  excelSource: string
): boolean {
  return resolveExcelMarkerPattern(memoqSource, excelSource) !== null;
}

function resolveExcelMarkerPattern(memoqSource: string, excelSource: string): RegExp | null {
  const memoqSkeleton = buildSkeleton(memoqSource, MEMOQ_MARKER_PATTERN);
  return [EXCEL_LINE_BREAK_PATTERN, EXCEL_MARKUP_PATTERN].find((pattern) =>
    buildSkeleton(excelSource, pattern) === memoqSkeleton
  ) ?? null;
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

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function failure(reason: string): MemoqTargetMappingResult {
  return { ok: false, reason };
}
