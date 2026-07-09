import { normalizeText } from '../../utils.ts';

export const GIENTRANS_DEFAULT_TAG_TOKEN_PATTERN = /❮[^❮❯]+❯/g;
export const GIENTRANS_NEWLINE_TAG_TOKEN = '\\n';

const GIENTRANS_DEFAULT_TAG_TOKEN_AT_PATTERN = /❮[^❮❯]+❯/y;
const GIENTRANS_BRACE_TAG_TOKEN_PATTERN = /\{\d+\}/g;
const GIENTRANS_BRACE_TAG_TOKEN_AT_PATTERN = /\{\d+\}/y;
const GIENTRANS_NEWLINE_TAG_TOKEN_PATTERN = /\\n/g;
const GIENTRANS_XML_OPEN_TAG_PATTERN = /^<([A-Za-z][\w-]*)(=[^<>]+)>$/;
const GIENTRANS_XML_BARE_OPEN_TAG_PATTERN = /^<([A-Za-z][\w-]*)>$/;
const GIENTRANS_XML_CLOSE_TAG_PATTERN = /^<\/([A-Za-z][\w-]*)>$/;
const GIENTRANS_KNOWN_XML_TAG_NAMES = new Set(['color', 'size']);

export interface GientTransMarkupToken {
  raw: string;
  canonical: string;
  endIndex: number;
}

export function normalizeGientTransInlineMarkup(value: string): string {
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

    const xmlToken = findGientTransXmlTagTokenAt(value, index, openXmlTagNames);
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

export function findGientTransMarkupTokenAt(
  value: string,
  index: number
): GientTransMarkupToken | null {
  return (
    findGientTransDefaultTagTokenAt(value, index) ??
    findGientTransBraceTagTokenAt(value, index) ??
    findGientTransXmlTagTokenAt(value, index, undefined, { allowGenericXmlTags: true }) ??
    findGientTransNewlineTagTokenAt(value, index)
  );
}

export function gientransXmlTagToDefaultToken(raw: string): string | null {
  const openTag = raw.match(GIENTRANS_XML_OPEN_TAG_PATTERN);
  if (openTag) {
    return `❮${openTag[1]}${openTag[2]}❯`;
  }

  const bareOpenTag = raw.match(GIENTRANS_XML_BARE_OPEN_TAG_PATTERN);
  if (bareOpenTag) {
    return `❮${bareOpenTag[1]}❯`;
  }

  const closeTag = raw.match(GIENTRANS_XML_CLOSE_TAG_PATTERN);
  if (closeTag) {
    return `❮/${closeTag[1]}❯`;
  }

  return null;
}

export function normalizeGientTransDomTagToken(token: string): string {
  return token;
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
  openXmlTagNames?: string[],
  options?: { allowGenericXmlTags?: boolean }
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
    openXmlTagNames?.push(openTag[1]);
    return {
      raw,
      canonical: `❮${openTag[1]}${openTag[2]}❯`,
      endIndex: closingIndex + 1
    };
  }

  const bareOpenTag = raw.match(GIENTRANS_XML_BARE_OPEN_TAG_PATTERN);
  if (bareOpenTag && options?.allowGenericXmlTags) {
    return {
      raw,
      canonical: `❮${bareOpenTag[1]}❯`,
      endIndex: closingIndex + 1
    };
  }

  const closeTag = raw.match(GIENTRANS_XML_CLOSE_TAG_PATTERN);
  if (!closeTag) {
    return null;
  }

  const closeTagName = closeTag[1];
  const matchingOpenIndex = openXmlTagNames?.lastIndexOf(closeTagName) ?? -1;
  if (
    matchingOpenIndex === -1 &&
    !GIENTRANS_KNOWN_XML_TAG_NAMES.has(closeTagName) &&
    !options?.allowGenericXmlTags
  ) {
    return null;
  }

  if (matchingOpenIndex !== -1) {
    openXmlTagNames?.splice(matchingOpenIndex, 1);
  }

  return {
    raw,
    canonical: `❮/${closeTagName}❯`,
    endIndex: closingIndex + 1
  };
}

function findGientTransNewlineTagTokenAt(
  value: string,
  index: number
): GientTransMarkupToken | null {
  if (value[index] !== '\\' || value[index + 1] !== 'n') {
    return null;
  }

  return {
    raw: GIENTRANS_NEWLINE_TAG_TOKEN,
    canonical: GIENTRANS_NEWLINE_TAG_TOKEN,
    endIndex: index + GIENTRANS_NEWLINE_TAG_TOKEN.length
  };
}
