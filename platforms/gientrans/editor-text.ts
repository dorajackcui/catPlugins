import {
  isLegacyGientTransTag,
  matchGientTransSourceTags,
  normalizeGientTransDomTagToken,
  normalizeGientTransEquivText,
  readGientTransWrappedEquivText
} from '../../domain/gientrans-markup.ts';

const ZERO_WIDTH_EDITOR_MARKERS = /[\u200B\uFEFF\u2060]/g;

export type GientTransTagHtmlLookup = ReadonlyMap<string, readonly string[]>;

interface OpenTag {
  token: string;
  html: string;
}

const TAG_INPUT_SELECTOR = 'input[type="tag"], input.tag';

export function readGientTransTagIdentities(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(TAG_INPUT_SELECTOR), input => {
    const chipId = input.getAttribute('tid') || input.parentElement?.closest('[tid]')?.getAttribute('tid');
    const identity = readTagIdentity(input);
    return chipId ? JSON.stringify([chipId, identity]) : identity;
  });
}

export function tagIdentitiesFromEditorHtml(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return readGientTransTagIdentities(template.content);
}

/**
 * GientTrans flags horizontal whitespace immediately before a real line break
 * as "Space at end of line". Excel keeps that whitespace verbatim, so remove
 * only the invalid line-ending padding while preserving indentation and
 * literal backslash-n tag tokens.
 */
export function prepareGientTransTargetText(value: string, sourceTokens: Iterable<string> = []): string {
  if (!/\r|[ \t]+\n/.test(value)) return value;
  let prepared = '';
  let cursor = 0;
  for (const { start, end } of matchGientTransSourceTags(value, sourceTokens)) {
    prepared += preparePlainText(value.slice(cursor, start)) + value.slice(start, end);
    cursor = end;
  }
  return prepared + preparePlainText(value.slice(cursor));
}

function preparePlainText(value: string): string {
  return value
    .replace(/[ \t]+(?=\r\n|\r|\n)/g, '')
    .replace(/\r\n?/g, '\n');
}

export function normalizeGientTransEditorText(value: string): string {
  return value
    .replace(/\u00A0/g, ' ')
    .replace(ZERO_WIDTH_EDITOR_MARKERS, '');
}

export function gientransTextToEditorHtml(
  value: string,
  tagHtmlByToken?: GientTransTagHtmlLookup,
  pairedClosers?: GientTransTagHtmlLookup
): string {
  let html = '';
  const tagUseCounts = new Map<string, number>();
  const openTags: OpenTag[] = [];
  const pairedUseCounts = new Map<string, number>();
  let cursor = 0;
  for (const { start, end, token } of matchGientTransSourceTags(value, tagHtmlByToken?.keys() ?? [])) {
    html += plainTextToEditorHtml(value.slice(cursor, start));
    const sourceHtml = takeTagHtml(tagHtmlByToken, tagUseCounts, token);
    const pair = sourceHtml && pairedClosingKey(token, sourceHtml, openTags);
    const tag = pair && takeTagHtml(pairedClosers, pairedUseCounts, pair);
    html += tag || sourceHtml || plainTextToEditorHtml(value.slice(start, end));
    cursor = end;
  }
  return html + plainTextToEditorHtml(value.slice(cursor));
}

function plainTextToEditorHtml(value: string): string {
  let html = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '\r') {
      if (value[index + 1] === '\n') {
        index += 1;
      }
      html += '<span class="whitechar lf" contenteditable="false">\n</span>\u200B';
      continue;
    }

    if (char === '\n') {
      html += '<span class="whitechar lf" contenteditable="false">\n</span>\u200B';
      continue;
    }

    if (char === '\t') {
      html += '<span class="whitechar tab" contenteditable="false">\t</span>\u200B';
      continue;
    }

    if (char === ' ') {
      html += '<span class="whitechar sp" contenteditable="false"> </span>\u200B';
      continue;
    }

    if (char === '\u00A0') {
      html += '<span class="whitechar nbsp" contenteditable="false">\u00A0</span>\u2060';
      continue;
    }

    html += escapeHtml(char);
  }

  return html;
}

export function readGientTransEditorText(element: HTMLElement | null, sourceTokens?: Set<string>): string {
  if (!element) {
    return '';
  }

  return normalizeGientTransEditorText(serializeGientTransEditorText(element, sourceTokens));
}

export function readGientTransEditorTextPreservingNbsp(
  element: HTMLElement | null
): string {
  if (!element) {
    return '';
  }

  return stripEditorMarkers(serializeGientTransEditorText(element));
}

export function collectGientTransTagHtmlByToken(
  element: HTMLElement | null
) {
  const tagHtmlByToken = new Map<string, string[]>();
  const pairedClosers = new Map<string, string[]>();
  if (!element || typeof element.querySelectorAll !== 'function') {
    return { tagHtmlByToken, pairedClosers };
  }

  const openTags: OpenTag[] = [];
  for (const input of Array.from(element.querySelectorAll<HTMLInputElement>(TAG_INPUT_SELECTOR))) {
    const token = readSourceTagToken(input);
    if (!token) {
      continue;
    }

    const html = (input.closest('.tagspan, span[contenteditable="false"]') ?? input).outerHTML;
    const pairedKey = pairedClosingKey(token, html, openTags);
    appendTagHtml(tagHtmlByToken, token, html);
    if (pairedKey) {
      appendTagHtml(pairedClosers, pairedKey, html);
    }
  }

  return { tagHtmlByToken, pairedClosers };
}

function appendTagHtml(lookup: Map<string, string[]>, key: string, html: string): void {
  const entries = lookup.get(key) ?? [];
  entries.push(html);
  lookup.set(key, entries);
}

// Anonymous closers have distinct native IDs. Index a close under its
// opening chip, including its ID, so repeated and nested pairs stay together.
function pairedClosingKey(token: string, html: string, openTags: OpenTag[]): string | null {
  if (token.startsWith('❮/') && openTags.length) {
    const name = token.slice(2, -1).trim();
    const opening = openTags[openTags.length - 1];
    if (!name || opening.token.match(/^❮([\w.:-]+)/)?.[1] === name) {
      openTags.pop();
      return JSON.stringify([opening.html, token]);
    }
  } else if (/^❮[A-Za-z_]/.test(token) && !token.endsWith('/❯')) {
    openTags.push({ token, html });
  }
  return null;
}

export function stripEditorMarkers(value: string): string {
  return value.replace(ZERO_WIDTH_EDITOR_MARKERS, '');
}

function serializeGientTransEditorText(element: HTMLElement, sourceTokens?: Set<string>): string {
  const childNodes = listChildNodes(element);
  if (childNodes.length === 0) {
    return element.innerText || element.textContent || '';
  }

  let value = '';
  for (const child of childNodes) {
    value += serializeGientTransNodeText(child, sourceTokens);
  }
  return value || element.innerText || element.textContent || '';
}

function serializeGientTransNodeText(node: ChildNode, sourceTokens?: Set<string>): string {
  if (node.nodeType === 3) {
    return node.textContent || '';
  }

  if (node.nodeType !== 1) {
    return node.textContent || '';
  }

  const element = node as HTMLElement;
  const childNodes = listChildNodes(element);
  const input = !childNodes.length || element.matches?.('.tagspan')
    ? findGientTransTagInput(element) : null;
  if (input) {
    const token = readSourceTagToken(input);
    if (token) sourceTokens?.add(token);
    return token ?? readTagIdentity(input);
  }
  if (childNodes.length > 0) {
    let value = '';
    for (const child of childNodes) {
      value += serializeGientTransNodeText(child, sourceTokens);
    }
    return value;
  }

  return element.textContent || '';
}

function listChildNodes(element: { childNodes?: unknown }): ChildNode[] {
  if (!element.childNodes || typeof element.childNodes !== 'object') {
    return [];
  }
  return Array.from(element.childNodes as ArrayLike<ChildNode>);
}

function readSourceTagToken(input: HTMLInputElement): string | null {
  const identity = readTagIdentity(input);
  const equiv = input.getAttribute('equiv-text') ||
    input.parentElement?.closest('.tagspan, span[contenteditable="false"]')?.getAttribute('equiv-text') ||
    readGientTransWrappedEquivText(identity) ||
    readGientTransWrappedEquivText(input.getAttribute('title') ?? '');
  if (equiv) return normalizeGientTransEquivText(equiv);
  return isLegacyGientTransTag(identity) ? normalizeGientTransDomTagToken(identity) : null;
}

function readTagIdentity(input: HTMLInputElement): string {
  return (
    input.getAttribute('tfull') ||
    input.getAttribute('value') ||
    input.getAttribute('title') ||
    input.value ||
    ''
  );
}

function findGientTransTagInput(element: HTMLElement): HTMLInputElement | null {
  if (
    typeof HTMLInputElement !== 'undefined' &&
    element instanceof HTMLInputElement &&
    (element.getAttribute('type') === 'tag' || element.classList.contains('tag'))
  ) {
    return element;
  }

  if (typeof element.querySelector !== 'function') {
    return null;
  }

  return element.querySelector<HTMLInputElement>(TAG_INPUT_SELECTOR);
}

function takeTagHtml(
  tagHtmlByToken: GientTransTagHtmlLookup | undefined,
  tagUseCounts: Map<string, number>,
  token: string
): string | null {
  const entries = tagHtmlByToken?.get(token);
  if (!entries?.length) {
    return null;
  }

  const currentIndex = tagUseCounts.get(token) ?? 0;
  tagUseCounts.set(token, currentIndex + 1);
  return entries[Math.min(currentIndex, entries.length - 1)] ?? null;
}

function escapeHtml(value: string): string {
  switch (value) {
    case '&':
      return '&amp;';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    case '"':
      return '&quot;';
    case "'":
      return '&#39;';
    default:
      return value;
  }
}
