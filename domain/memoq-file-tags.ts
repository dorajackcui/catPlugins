import { normalizeText } from '../shared/utils.ts';

export const EXCEL_MARKUP_PATTERN =
  /\{[^{}<>]+\}|<\/>|<\/?[\p{L}_:][^<>]*>|\r\n|[\r\n]/gu;
const EXCEL_LINE_BREAK_PATTERN = /\r\n|[\r\n]/g;
// Some game files literally store the four characters backslash-r-backslash-n.
// Only treat them as tags when the editor source proves that its filter protected them.
const ESCAPED_BREAK = /\\r\\n/;
const FILE_BREAKS = new RegExp(`${EXCEL_LINE_BREAK_PATTERN.source}|${ESCAPED_BREAK.source}`, 'g');
export const FILE_MARKUP = new RegExp(`${EXCEL_MARKUP_PATTERN.source}|${ESCAPED_BREAK.source}`, 'gu');
export const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;
const TAG_SYNTAX = new RegExp(MEMOQ_MARKER_PATTERN.source + '|' + FILE_MARKUP.source, 'gu');
const SKELETON_TOKEN = '\ufffc';

type MarkerKind = 'empty' | 'open' | 'close';

export interface MemoqTagSpan {
  token: string;
  start: number;
  end: number;
  kind: MarkerKind;
}

export function resolveExcelMarkerPattern(memoqSource: string, excelSource: string, learnDelimiters = false): RegExp | null {
  // An editor export already carries native marker IDs and kinds. It can
  // describe just one side of a formatting pair split across segments.
  if (normalizeText(excelSource) === normalizeText(memoqSource)) {
    return MEMOQ_MARKER_PATTERN;
  }
  const memoqSkeleton = buildSkeleton(memoqSource, MEMOQ_MARKER_PATTERN);
  const known = [EXCEL_LINE_BREAK_PATTERN, EXCEL_MARKUP_PATTERN, FILE_BREAKS, FILE_MARKUP].find((pattern) =>
    buildSkeleton(excelSource, pattern) === memoqSkeleton
  );
  if (known || !learnDelimiters) return known ?? null;
  const derived = deriveMemoqFileTagPattern(memoqSource, excelSource);
  return derived && buildSkeleton(excelSource, derived) === memoqSkeleton ? derived : null;
}

function buildSkeleton(value: string, pattern: RegExp): string {
  return normalizeText(
    value.replace(pattern, SKELETON_TOKEN)
  );
}

/** Markup outside native insertion spans remains literal in the translation. */
export function readLiteralMemoqTags(value: string, pattern: RegExp, byId: boolean): string[] {
  const otherNotation = pattern === MEMOQ_MARKER_PATTERN ? FILE_MARKUP : MEMOQ_MARKER_PATTERN;
  return value.replace(pattern, SKELETON_TOKEN).match(byId ? TAG_SYNTAX : otherNotation) ?? [];
}

/** A row with no native chips cannot authorize a marker typed into the target. */
export function findForeignMemoqTagInPlainRow(source: string, target: string): string | undefined {
  const literal = new Set(source.match(FILE_MARKUP) ?? []);
  return target.match(TAG_SYNTAX)?.find(token =>
    token.search(MEMOQ_MARKER_PATTERN) >= 0 || (!isLineBreak(token) && !literal.has(token))
  );
}

export function maskMemoqMarkers(value: string): string {
  return value.replace(MEMOQ_MARKER_PATTERN, SKELETON_TOKEN);
}

/** Keep offsets in the original cell text, including two-code-unit CRLFs. */
export function readMemoqTagSpans(value: string, pattern: RegExp): MemoqTagSpan[] {
  const native = pattern === MEMOQ_MARKER_PATTERN;
  return Array.from(value.matchAll(pattern), match => {
    const token = match[0];
    return {
      token: !native && isLineBreak(token) ? '\n' : token,
      start: match.index,
      end: match.index + token.length,
      kind: native ? classifyMemoqToken(token) : classifyExcelToken(token)
    };
  });
}

function classifyExcelToken(token: string): MarkerKind {
  if (token.startsWith('{') || isLineBreak(token) || token.startsWith('\\')) {
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

/** Learn which file tokens were protected from the visible gaps in this row. */
function deriveMemoqFileTagPattern(nativeSource: string, fileSource: string): RegExp | null {
  const groups = [...nativeSource.matchAll(new RegExp('(?:' + MEMOQ_MARKER_PATTERN.source + ')+', 'g'))];
  if (!groups.length) return null;
  let fileCursor = groups[0].index;
  if (!fileSource.startsWith(nativeSource.slice(0, fileCursor))) return null;
  const families = new Set<string>();
  const fileTokens = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const next = groups[index + 1];
    const visible = nativeSource.slice(group.index + group[0].length, next?.index);
    const end = next ? fileSource.indexOf(visible, fileCursor + 1) : fileSource.length - visible.length;
    if (end <= fileCursor || !fileSource.startsWith(visible, end)) return null;
    const gap = fileSource.slice(fileCursor, end);
    for (const [token] of gap.matchAll(FILE_MARKUP)) fileTokens.add(token);
    for (const piece of gap.split(FILE_MARKUP)) {
      if (!piece) continue;
      const open = /^[^\p{L}\p{N}\s]+/u.exec(piece)?.[0];
      const close = /[^\p{L}\p{N}\s]+$/u.exec(piece)?.[0];
      if (!open || !close || open.length + close.length >= piece.length) continue;
      const start = escapePattern(open);
      const stop = escapePattern(close);
      families.add(start + '(?:(?!' + start + '|' + stop + ')[\\s\\S])+?' + stop);
    }
    fileCursor = end + visible.length;
  }
  const patterns = [...families];
  for (const token of [...fileTokens].sort((a, b) => b.length - a.length)) {
    patterns.push(/^[\r\n]+$/.test(token) ? '\\r\\n|[\\r\\n]' : escapePattern(token));
  }
  if (!patterns.length) return null;
  // The caller verifies the complete source skeleton, ID count and adjacency.
  // Matching the whole family also exposes a foreign target value to validation.
  return new RegExp(patterns.join('|'), 'gu');
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
