import {
  gientransOriginalTagSpelling,
  matchGientTransSourceTags,
  normalizeGientTransEquivText,
  readGientTransLegacyTagToken,
  readGientTransWrappedEquivText
} from '../../domain/gientrans-markup.ts';

type TagHtmlLookup = ReadonlyMap<string, readonly string[]>;

export interface GientTransSourceTags {
  byToken: TagHtmlLookup;
  pairedClosers: TagHtmlLookup;
}

interface OpenTag {
  token: string;
  html: string;
}

const CHIP_SELECTOR = '.tagspan, span[contenteditable="false"]';
const TAG_INPUT_SELECTOR = 'input[type="tag"], input.tag';

export function readGientTransTagIdentities(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>(TAG_INPUT_SELECTOR), input => {
    const chipId = readTagId(input);
    const identity = readTagIdentity(input);
    return chipId ? JSON.stringify([chipId, identity]) : identity;
  });
}

export function tagIdentitiesFromEditorHtml(html: string): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  return readGientTransTagIdentities(template.content);
}

export function collectGientTransSourceTags(element: HTMLElement | null): GientTransSourceTags {
  const byToken = new Map<string, string[]>();
  const pairedClosers = new Map<string, string[]>();
  if (!element || typeof element.querySelectorAll !== 'function') {
    return { byToken, pairedClosers };
  }

  const openTags: OpenTag[] = [];
  const groupEnds = new Map<string, string>();
  for (const input of Array.from(element.querySelectorAll<HTMLInputElement>(TAG_INPUT_SELECTOR))) {
    const token = readSourceTagToken(input, groupEnds);
    if (!token) {
      continue;
    }

    const html = (input.closest(CHIP_SELECTOR) ?? input).outerHTML;
    const pairedKey = pairedClosingKey(token, html, openTags);
    appendTagHtml(byToken, token, html);
    if (pairedKey) {
      appendTagHtml(pairedClosers, pairedKey, html);
    }
  }

  return { byToken, pairedClosers };
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
    // A native XLIFF group closes with /g even when its opening chip uses equiv-text.
    if (!name || name === 'g' || opening.token.match(/^❮([\w.:-]+)/)?.[1] === name) {
      openTags.pop();
      return JSON.stringify([opening.html, token]);
    }
  } else if (/^❮[A-Za-z_]/.test(token) && !token.endsWith('/❯')) {
    openTags.push({ token, html });
  }
  return null;
}

// Walk translation tokens in order, choosing each chip from this source row.
export function* matchGientTransSourceChips(value: string, tags: GientTransSourceTags) {
  const tagUseCounts = new Map<string, number>();
  const pairedUseCounts = new Map<string, number>();
  const openTags: OpenTag[] = [];
  for (const { start, end, token } of matchGientTransSourceTags(value, tags.byToken.keys())) {
    const sourceHtml = takeTagHtml(tags.byToken, tagUseCounts, token);
    if (!sourceHtml) continue;
    const pair = pairedClosingKey(token, sourceHtml, openTags);
    const html = (pair && takeTagHtml(tags.pairedClosers, pairedUseCounts, pair)) || sourceHtml;
    yield { start, end, html };
  }
}

export function readGientTransChipText(
  element: HTMLElement,
  groupEnds: Map<string, string>,
  sourceTokens?: Set<string>
): string | null {
  const input = findGientTransTagInput(element);
  if (!input) return null;
  const identity = readTagIdentity(input);
  const token = readSourceTagToken(input, groupEnds, identity);
  if (!token) return identity;
  sourceTokens?.add(token);
  return gientransOriginalTagSpelling(token);
}

function readTagId(input: HTMLInputElement): string | null | undefined {
  return input.getAttribute('tid') || input.parentElement?.closest('[tid]')?.getAttribute('tid');
}

function readSourceTagToken(
  input: HTMLInputElement,
  groupEnds: Map<string, string>,
  identity = readTagIdentity(input)
): string | null {
  const equiv = input.getAttribute('equiv-text') ||
    input.parentElement?.closest(CHIP_SELECTOR)?.getAttribute('equiv-text') ||
    readGientTransWrappedEquivText(identity) ||
    readGientTransWrappedEquivText(input.getAttribute('title') ?? '');
  const groupId = readTagId(input);
  if (equiv) {
    const token = normalizeGientTransEquivText(equiv);
    if (groupId && /^(?:❮|<)g\s/.test(identity) && !token.endsWith('/❯')) {
      const name = /^❮([A-Za-z_][\w.:-]*)(?:\s|=|❯)/.exec(token)?.[1];
      if (name) groupEnds.set(groupId, `❮/${name}❯`);
    }
    return token;
  }
  // The closing chip carries the opening chip's tid, but often has no equiv-text of its own.
  if (groupId && (identity === '❮/g❯' || identity === '</g>')) {
    const close = groupEnds.get(groupId);
    groupEnds.delete(groupId);
    if (close) return close;
  }
  return readGientTransLegacyTagToken(identity);
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
  lookup: TagHtmlLookup,
  tagUseCounts: Map<string, number>,
  token: string
): string | null {
  const entries = lookup.get(token);
  if (!entries?.length) {
    return null;
  }

  const currentIndex = tagUseCounts.get(token) ?? 0;
  tagUseCounts.set(token, currentIndex + 1);
  return entries[Math.min(currentIndex, entries.length - 1)] ?? null;
}
