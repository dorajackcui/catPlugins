import { normalizeText } from '../shared/utils.ts';

export type PhraseMarkupPart =
  | {
      type: 'text';
      value: string;
    }
  | {
      type: 'tag';
      value: string;
    };

const PHRASE_XML_LIKE_TAG_SOURCE =
  String.raw`(?:<\/\>|<\/?[\w-]+(?:\s*=\s*[^<>\s]+)?(?:\s+[^<>]*)?\/?>)`;
const PHRASE_TAG_TOKEN_PATTERN = new RegExp(
  String.raw`\{\d+\}|${PHRASE_XML_LIKE_TAG_SOURCE}`,
  'g'
);
const PHRASE_XML_LIKE_TAG_CLIP_PATTERN = new RegExp(
  String.raw`\d+\s*(${PHRASE_XML_LIKE_TAG_SOURCE})`,
  'g'
);

export function normalizePhraseTagClipText(value: string): string {
  return normalizeText(value)
    .replace(/\d+\s*(\{[^{}<>]+\})/g, '$1')
    .replace(/\d+\s*([|}])/g, '$1')
    .replace(PHRASE_XML_LIKE_TAG_CLIP_PATTERN, '$1');
}

export function splitPhraseMarkup(value: string): PhraseMarkupPart[] {
  const parts: PhraseMarkupPart[] = [];
  let cursor = 0;

  for (const match of value.matchAll(PHRASE_TAG_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({
        type: 'text',
        value: value.slice(cursor, index)
      });
    }

    parts.push({
      type: 'tag',
      value: match[0]
    });
    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    parts.push({
      type: 'text',
      value: value.slice(cursor)
    });
  }

  return parts.filter((part) => part.value.length > 0);
}
