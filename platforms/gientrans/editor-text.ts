import { matchGientTransSourceTags } from '../../domain/gientrans-markup.ts';
import {
  matchGientTransSourceChips,
  readGientTransChipText,
  type GientTransSourceTags
} from './editor-tags.ts';

const ZERO_WIDTH_EDITOR_MARKERS = /[\u200B\uFEFF\u2060]/g;

const EDITOR_HTML: Readonly<Record<string, string>> = {
  ' ': '<span class="whitechar sp" contenteditable="false"> </span>\u200B',
  '\t': '<span class="whitechar tab" contenteditable="false">\t</span>\u200B',
  '\n': '<span class="whitechar lf" contenteditable="false">\n</span>\u200B',
  '\u00A0': '<span class="whitechar nbsp" contenteditable="false">\u00A0</span>\u2060',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function plainTextToEditorHtml(value: string): string {
  return value.replace(/\r\n?|[ \t\n\u00A0&<>"']/g, char => EDITOR_HTML[char.startsWith('\r') ? '\n' : char]);
}

export function prepareGientTransTarget(value: string, tags?: GientTransSourceTags) {
  const text = prepareTargetText(value, tags);
  if (!tags?.byToken.size) return { text, html: plainTextToEditorHtml(text) };

  let html = '';
  let cursor = 0;
  for (const chip of matchGientTransSourceChips(text, tags)) {
    html += plainTextToEditorHtml(text.slice(cursor, chip.start)) + chip.html;
    cursor = chip.end;
  }
  return { text, html: html + plainTextToEditorHtml(text.slice(cursor)) };
}

// GientTrans flags horizontal padding before a real line break. A literal
// source chip may itself contain that padding, which is part of its spelling.
function prepareTargetText(value: string, tags?: GientTransSourceTags): string {
  if (!/\r|[ \t]\n/.test(value)) return value;
  const hasLineSensitiveChip = tags && Array.from(tags.byToken.keys()).some(token => /[\r\n]|[ \t]$/.test(token));
  if (!hasLineSensitiveChip) {
    return preparePlainText(value);
  }

  let text = '';
  let cursor = 0;
  for (const { start, end } of matchGientTransSourceTags(value, tags.byToken.keys())) {
    text += preparePlainText(value.slice(cursor, start)) + value.slice(start, end);
    cursor = end;
  }
  return text + preparePlainText(value.slice(cursor));
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

export function readGientTransEditorText(element: HTMLElement | null, sourceTokens?: Set<string>): string {
  return normalizeGientTransEditorText(serializeEditorText(element, sourceTokens));
}

export function readGientTransEditorTextPreservingNbsp(element: HTMLElement | null): string {
  return stripEditorMarkers(serializeEditorText(element));
}

export function stripEditorMarkers(value: string): string {
  return value.replace(ZERO_WIDTH_EDITOR_MARKERS, '');
}

function serializeEditorText(element: HTMLElement | null, sourceTokens?: Set<string>): string {
  if (!element) return '';
  const groupEnds = new Map<string, string>();

  function readNode(node: ChildNode): string {
    if (node.nodeType !== 1) return node.textContent || '';

    const child = node as HTMLElement;
    const children = child.childNodes;
    if (!children?.length || child.matches?.('.tagspan')) {
      const chip = readGientTransChipText(child, groupEnds, sourceTokens);
      if (chip !== null) return chip;
    }
    return children?.length ? Array.from(children, readNode).join('') : child.textContent || '';
  }

  return Array.from(element.childNodes ?? [], readNode).join('') || element.innerText || element.textContent || '';
}
