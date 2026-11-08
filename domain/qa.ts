import {
  matchGientTransSourceTags,
  normalizeGientTransEditorMarkup,
  normalizeGientTransInlineMarkup
} from './gientrans-markup.ts';
import type { PageSegment } from '../shared/translation-types.ts';

export function extractPlaceholderTokens(
  input: string,
  platform?: PageSegment['platform'],
  sourceTokens: readonly string[] = []
): string[] {
  if (platform !== 'gientrans' || !sourceTokens.length) {
    return extractTextPlaceholders(input, platform);
  }
  const result: string[] = [];
  let cursor = 0;
  for (const { start, end, token } of matchGientTransSourceTags(input, sourceTokens)) {
    result.push(...extractTextPlaceholders(input.slice(cursor, start), platform), token);
    cursor = end;
  }
  return result.concat(extractTextPlaceholders(input.slice(cursor), platform));
}

function extractTextPlaceholders(input: string, platform?: PageSegment['platform']): string[] {
  const tokens: Array<{ index: number; token: string }> = [];
  const normalizedInput = platform === 'gientrans'
    ? normalizeGientTransEditorMarkup(input)
    : normalizeGientTransInlineMarkup(input);
  const patterns = [
    /\{\d+>/g,
    /<\d+\}/g,
    /\{[^{}<>]+\}/g,
    /❮[^❮❯]+❯/g,
    /\\n/g,
    /<\/?[\w-]+(?:\s+[^<>]*)?>/g,
    /%[sd]/g
  ];

  for (const pattern of patterns) {
    for (const match of normalizedInput.matchAll(pattern)) {
      tokens.push({
        index: match.index ?? 0,
        token: match[0]
      });
    }
  }

  return tokens
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.token);
}

export function placeholdersMatch(
  source: string,
  target: string,
  platform?: PageSegment['platform'],
  knownSourceTokens?: readonly string[]
): boolean {
  const sourceTokens = extractPlaceholderTokens(source, platform, knownSourceTokens);
  const targetTokens = extractPlaceholderTokens(target, platform, knownSourceTokens);

  if (sourceTokens.length !== targetTokens.length) {
    return false;
  }

  return sourceTokens.every((token, index) => token === targetTokens[index]);
}
