import {
  findGientTransMarkupTokenAt,
  normalizeGientTransDomTagToken
} from '../../domain/gientrans-markup.ts';
import type { GientTransMarkupToken } from '../../domain/gientrans-markup.ts';

const ZERO_WIDTH_EDITOR_MARKERS = /[\u200B\uFEFF\u2060]/g;

export type GientTransTagHtmlLookup = ReadonlyMap<string, readonly string[]>;

/**
 * GientTrans flags horizontal whitespace immediately before a real line break
 * as "Space at end of line". Excel keeps that whitespace verbatim, so remove
 * only the invalid line-ending padding while preserving indentation and
 * literal backslash-n tag tokens.
 */
export function prepareGientTransTargetText(value: string): string {
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
  tagHtmlByToken?: GientTransTagHtmlLookup
): string {
  let html = '';
  const tagUseCounts = new Map<string, number>();

  for (let index = 0; index < value.length; index += 1) {
    const tagMatch = findGientTransMarkupTokenAt(value, index);
    if (tagMatch) {
      const tagHtml = takeMatchingTagHtml(tagHtmlByToken, tagUseCounts, tagMatch);
      if (tagHtml) {
        html += tagHtml;
      } else {
        html += escapeHtmlText(tagMatch.raw);
      }
      index = tagMatch.endIndex - 1;
      continue;
    }

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

export function readGientTransEditorText(element: HTMLElement | null): string {
  if (!element) {
    return '';
  }

  return normalizeGientTransEditorText(serializeGientTransEditorText(element));
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
): Map<string, string[]> {
  const tagHtmlByToken = new Map<string, string[]>();
  if (!element || typeof element.querySelectorAll !== 'function') {
    return tagHtmlByToken;
  }

  const tagContainers = Array.from(
    element.querySelectorAll<HTMLElement>('.tagspan, span[contenteditable="false"]')
  );

  for (const tagContainer of tagContainers) {
    const token = readGientTransTagToken(tagContainer);
    if (!token) {
      continue;
    }

    const html = tagContainer.outerHTML;
    const entries = tagHtmlByToken.get(token) ?? [];
    entries.push(html);
    tagHtmlByToken.set(token, entries);
  }

  return tagHtmlByToken;
}

export function containsMappedGientTransTag(
  value: string,
  tagHtmlByToken: GientTransTagHtmlLookup
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const tagMatch = findGientTransMarkupTokenAt(value, index);
    if (!tagMatch) {
      continue;
    }

    if (tagHtmlByToken.has(tagMatch.canonical) || tagHtmlByToken.has(tagMatch.raw)) {
      return true;
    }

    index = tagMatch.endIndex - 1;
  }

  return false;
}

export function stripEditorMarkers(value: string): string {
  return value.replace(ZERO_WIDTH_EDITOR_MARKERS, '');
}

function serializeGientTransEditorText(element: HTMLElement): string {
  const childNodes = listChildNodes(element);
  if (childNodes.length === 0) {
    return element.innerText || element.textContent || '';
  }

  let value = '';
  for (const child of childNodes) {
    value += serializeGientTransNodeText(child);
  }
  return value || element.innerText || element.textContent || '';
}

function serializeGientTransNodeText(node: ChildNode): string {
  if (node.nodeType === 3) {
    return node.textContent || '';
  }

  if (node.nodeType !== 1) {
    return node.textContent || '';
  }

  const element = node as HTMLElement;
  const tagToken = readGientTransTagToken(element);
  if (tagToken !== null) {
    return tagToken;
  }

  const childNodes = listChildNodes(element);
  if (childNodes.length > 0) {
    let value = '';
    for (const child of childNodes) {
      value += serializeGientTransNodeText(child);
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

function readGientTransTagToken(element: HTMLElement): string | null {
  const input = findGientTransTagInput(element);
  if (!input) {
    return null;
  }

  const token =
    input.getAttribute('tfull') ||
    input.getAttribute('value') ||
    input.getAttribute('title') ||
    input.value ||
    null;

  return token === null ? null : normalizeGientTransDomTagToken(token);
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

  return element.querySelector<HTMLInputElement>('input[type="tag"], input.tag');
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

function takeMatchingTagHtml(
  tagHtmlByToken: GientTransTagHtmlLookup | undefined,
  tagUseCounts: Map<string, number>,
  tagMatch: GientTransMarkupToken
): string | null {
  const candidateTokens =
    tagMatch.raw === tagMatch.canonical
      ? [tagMatch.canonical]
      : [tagMatch.canonical, tagMatch.raw];

  for (const token of candidateTokens) {
    const tagHtml = takeTagHtml(tagHtmlByToken, tagUseCounts, token);
    if (tagHtml) {
      return tagHtml;
    }
  }

  return null;
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

function escapeHtmlText(value: string): string {
  let escaped = '';
  for (const char of value) {
    escaped += escapeHtml(char);
  }
  return escaped;
}
