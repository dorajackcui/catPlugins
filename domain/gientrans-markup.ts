import { normalizeText } from '../shared/utils.ts';

export const GIENTRANS_DEFAULT_TAG_TOKEN_PATTERN = /❮[^❮❯]+❯/g;
export const GIENTRANS_NEWLINE_TAG_TOKEN = '\\n';

const GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN = /❮[^❮❯]+❯/y;
const GIENTRANS_BRACE_TAG_TOKEN_PATTERN = /\{\d+\}/g;
const GIENTRANS_BRACE_TAG_TOKEN_AT_PATTERN = /\{\d+\}/y;
const GIENTRANS_NEWLINE_TAG_TOKEN_PATTERN = /\\n/g;
const GIENTRANS_XML_OPEN_TAG_PATTERN = /^<([A-Za-z][\w-]*)(=[^<>]+)>$/;
const GIENTRANS_XML_CLOSE_TAG_PATTERN = /^<\/([A-Za-z][\w-]*)>$/;
const GIENTRANS_KNOWN_XML_TAG_NAMES = new Set(['color', 'size']);
const GIENTRANS_PH_WRAPPER_PATTERN = /^(?:❮|<)ph\b[\s\S]*\/(?:❯|>)$/;
const GIENTRANS_WRAPPER_ATTRIBUTE_PATTERN =
  /\s+([^\s="'<>❮❯/]+)\s*=\s*(?:"(❰[^❰❱]*❱|[^"]*)"|'(❰[^❰❱]*❱|[^']*)')/g;
const GIENTRANS_NESTED_TAG_PATTERN = /❰([^❰❱]+)❱/g;

// Read one whole game tag, including quoted attribute values containing '>'.
// Keep names and values case-sensitive so different actions cannot share a chip.
const xmlName = String.raw`[A-Za-z_][\w.:-]*`;
const xmlValue = String.raw`(?:"[^"]*"|'[^']*'|[^\s<>"'=]+)`;
const xmlAttribute = String.raw`\s+${xmlName}(?:\s*=\s*${xmlValue})?`;
const xmlTagAt = new RegExp(
  String.raw`<(?:/(?:${xmlName})?\s*|${xmlName}(?:=[^<>]+|(?:${xmlAttribute})*)\s*/?)>`,
  'y'
);

export interface GientTransMarkupToken {
  raw: string;
  canonical: string;
  endIndex: number;
}

export function normalizeGientTransEditorMarkup(value: string): string {
  return normalizeGientTransInlineMarkup(value, { allowGenericXmlTags: true });
}

export function normalizeGientTransInlineMarkup(
  value: string,
  options?: { allowGenericXmlTags?: boolean }
): string {
  let normalized = '';
  const openXmlTagNames: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const defaultToken = findGientTransDefaultTagTokenAt(value, index);
    if (defaultToken) {
      normalized += defaultToken.canonical;
      index = defaultToken.endIndex - 1;
      continue;
    }

    const braceToken = findGientTransBraceTagTokenAt(value, index);
    if (braceToken) {
      normalized += braceToken.canonical;
      index = braceToken.endIndex - 1;
      continue;
    }

    const xmlToken = options?.allowGenericXmlTags
      ? findEditorXmlTagAt(value, index)
      : findGientTransXmlTagTokenAt(value, index, openXmlTagNames);
    if (xmlToken) {
      normalized += xmlToken.canonical;
      index = xmlToken.endIndex - 1;
      continue;
    }

    if (value[index] === '\\' && value[index + 1] === 'n') {
      normalized += GIENTRANS_NEWLINE_TAG_TOKEN;
      index += 1;
      continue;
    }

    normalized += value[index];
  }

  return normalized;
}

export function stripGientTransInlineMarkup(value: string): string {
  return normalizeText(
    normalizeGientTransInlineMarkup(value)
      .replace(GIENTRANS_DEFAULT_TAG_TOKEN_PATTERN, '')
      .replace(GIENTRANS_BRACE_TAG_TOKEN_PATTERN, '')
      .replace(GIENTRANS_NEWLINE_TAG_TOKEN_PATTERN, '')
  );
}

// Match literal row-local spellings left to right. Longer spellings win when
// they start at the same position, and a matched span is never scanned again.
export function* matchGientTransSourceTags(value: string, sourceTokens: Iterable<string>) {
  const spellings = new Map<string, string>();
  for (const token of sourceTokens) {
    if (!token) continue;
    spellings.set(token, token);
    if (token.startsWith('❮') && token.endsWith('❯')) {
      const excel = `<${token.slice(1, -1)}>`;
      if (gientransXmlTagToDefaultToken(excel) === token && !spellings.has(excel)) {
        spellings.set(excel, token);
      }
    }
  }
  if (!spellings.size) return;

  const byFirstChar = new Map<string, string[]>();
  for (const spelling of [...spellings.keys()].sort((a, b) => b.length - a.length)) {
    const candidates = byFirstChar.get(spelling[0]) ?? [];
    candidates.push(spelling);
    byFirstChar.set(spelling[0], candidates);
  }
  for (let index = 0; index < value.length;) {
    const raw = byFirstChar.get(value[index])?.find(s => value.startsWith(s, index));
    if (raw) {
      const end = index + raw.length;
      yield { start: index, end, token: spellings.get(raw)! };
      index = end;
    } else {
      index += 1;
    }
  }
}

export function gientransXmlTagToDefaultToken(raw: string): string | null {
  const token = findEditorXmlTagAt(raw, 0);
  return token?.endIndex === raw.length ? token.canonical : null;
}

function findEditorXmlTagAt(value: string, index: number): GientTransMarkupToken | null {
  xmlTagAt.lastIndex = index;
  const match = xmlTagAt.exec(value);
  if (!match) {
    return null;
  }
  const raw = match[0];
  return { raw, canonical: `❮${raw.slice(1, -1)}❯`, endIndex: index + raw.length };
}

export function readGientTransWrappedEquivText(token: string): string | null {
  for (const [, name, doubleQuoted, singleQuoted] of token.matchAll(GIENTRANS_WRAPPER_ATTRIBUTE_PATTERN)) {
    if (name === 'equiv-text') {
      return decodeGientTransAttributeValue(doubleQuoted ?? singleQuoted);
    }
  }
  return null;
}

export function normalizeGientTransEquivText(value: string): string {
  const excel = value.replace(GIENTRANS_NESTED_TAG_PATTERN, '<$1>');
  return gientransXmlTagToDefaultToken(excel) ?? excel;
}

export function normalizeGientTransDomTagToken(token: string): string {
  const equiv = GIENTRANS_PH_WRAPPER_PATTERN.test(token) ? readGientTransWrappedEquivText(token) : null;
  return equiv === null ? gientransXmlTagToDefaultToken(token) ?? token : normalizeGientTransEquivText(equiv);
}

export function isLegacyGientTransTag(token: string): boolean {
  return /^(?:❮[^❮❯]+❯|\{\d+\}|\[[^\[\]\r\n]+\]|\\n)$/.test(token) ||
    gientransXmlTagToDefaultToken(token) !== null;
}

function decodeGientTransAttributeValue(value: string): string {
  return value.replace(
    /&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case '&quot;':
          return '"';
        case '&apos;':
          return "'";
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        default: {
          const numericValue = entity.startsWith('&#x') || entity.startsWith('&#X')
            ? Number.parseInt(entity.slice(3, -1), 16)
            : Number.parseInt(entity.slice(2, -1), 10);
          return Number.isFinite(numericValue) &&
            numericValue >= 0 &&
            numericValue <= 0x10ffff
            ? String.fromCodePoint(numericValue)
            : entity;
        }
      }
    }
  );
}

function findGientTransDefaultTagTokenAt(
  value: string,
  index: number
): GientTransMarkupToken | null {
  GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN.lastIndex = index;
  const match = GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: match[0],
    canonical: match[0],
    endIndex: index + match[0].length
  };
}

function findGientTransBraceTagTokenAt(
  value: string,
  index: number
): GientTransMarkupToken | null {
  GIENTRANS_BRACE_TAG_TOKEN_AT_PATTERN.lastIndex = index;
  const match = GIENTRANS_BRACE_TAG_TOKEN_AT_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: match[0],
    canonical: match[0],
    endIndex: index + match[0].length
  };
}

function findGientTransXmlTagTokenAt(
  value: string,
  index: number,
  openXmlTagNames: string[]
): GientTransMarkupToken | null {
  if (value[index] !== '<') {
    return null;
  }

  const closingIndex = value.indexOf('>', index + 1);
  if (closingIndex === -1) {
    return null;
  }

  const raw = value.slice(index, closingIndex + 1);
  const openTag = raw.match(GIENTRANS_XML_OPEN_TAG_PATTERN);
  if (openTag) {
    openXmlTagNames.push(openTag[1]);
    return {
      raw,
      canonical: `❮${openTag[1]}${openTag[2]}❯`,
      endIndex: closingIndex + 1
    };
  }

  const closeTag = raw.match(GIENTRANS_XML_CLOSE_TAG_PATTERN);
  if (!closeTag) {
    return null;
  }

  const closeTagName = closeTag[1];
  const matchingOpenIndex = openXmlTagNames.lastIndexOf(closeTagName);
  if (
    matchingOpenIndex === -1 &&
    !GIENTRANS_KNOWN_XML_TAG_NAMES.has(closeTagName)
  ) {
    return null;
  }

  if (matchingOpenIndex !== -1) {
    openXmlTagNames.splice(matchingOpenIndex, 1);
  }

  return {
    raw,
    canonical: `❮/${closeTagName}❯`,
    endIndex: closingIndex + 1
  };
}
