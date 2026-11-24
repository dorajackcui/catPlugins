import { normalizeText } from '../shared/utils.ts';

const GIENTRANS_DEFAULT_TAG_TOKEN_PATTERN = /❮[^❮❯]+❯/g;
const GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN = /❮[^❮❯]+❯/y;
const GIENTRANS_BRACE_TAG_TOKEN_PATTERN = /\{\d+\}/g;
const GIENTRANS_NEWLINE_TAG_TOKEN_PATTERN = /\\n/g;
const GIENTRANS_XML_OPEN_TAG_PATTERN = /^<([A-Za-z][\w-]*)(=[^<>]+)>$/;
const GIENTRANS_XML_CLOSE_TAG_PATTERN = /^<\/([A-Za-z][\w-]*)>$/;
const GIENTRANS_KNOWN_XML_TAG_NAMES = new Set(['color', 'size']);
const GIENTRANS_WRAPPER_ATTRIBUTE_PATTERN =
  /\s+([^\s="'<>❮❯/]+)\s*=\s*(?:"(❰[^❰❱]*❱|❮[^❮❯]*❯|[^"]*)"|'(❰[^❰❱]*❱|❮[^❮❯]*❯|[^']*)')/g;
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

interface GientTransMarkupToken {
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
    // Canonical chips can contain XML-looking text inside a quoted attribute.
    if (value[index] === '❮') {
      GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN.lastIndex = index;
      const chip = GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN.exec(value);
      if (chip) {
        normalized += chip[0];
        index += chip[0].length - 1;
        continue;
      }
    }

    if (value[index] === '<') {
      const tag = options?.allowGenericXmlTags
        ? findEditorXmlTagAt(value, index)
        : findGientTransXmlTagTokenAt(value, index, openXmlTagNames);
      if (tag) {
        normalized += tag.canonical;
        index = tag.endIndex - 1;
        continue;
      }
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
    const original = gientransOriginalTagSpelling(token);
    if (!spellings.has(original)) spellings.set(original, token);
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

export function gientransOriginalTagSpelling(token: string): string {
  if (!token.startsWith('❮') || !token.endsWith('❯')) return token;
  const original = `<${token.slice(1, -1)}>`;
  return gientransXmlTagToDefaultToken(original) === token ? original : token;
}

function gientransXmlTagToDefaultToken(raw: string): string | null {
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
  return { canonical: `❮${raw.slice(1, -1)}❯`, endIndex: index + raw.length };
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

export function readGientTransLegacyTagToken(identity: string): string | null {
  if (/^(?:❮[^❮❯]+❯|\{\d+\}|\[[^\[\]\r\n]+\]|\\n)$/.test(identity)) return identity;
  return gientransXmlTagToDefaultToken(identity);
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

function findGientTransXmlTagTokenAt(
  value: string,
  index: number,
  openXmlTagNames: string[]
): GientTransMarkupToken | null {
  const closingIndex = value.indexOf('>', index + 1);
  if (closingIndex === -1) {
    return null;
  }

  const raw = value.slice(index, closingIndex + 1);
  const openTag = raw.match(GIENTRANS_XML_OPEN_TAG_PATTERN);
  if (openTag) {
    openXmlTagNames.push(openTag[1]);
    return {
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
    canonical: `❮/${closeTagName}❯`,
    endIndex: closingIndex + 1
  };
}
