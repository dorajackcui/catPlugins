import { extractPlaceholderTokens } from './qa.ts';
import type { FillOutcome } from './types.ts';
import { delay, normalizeText } from './utils.ts';
import {
  findGientTransMarkupTokenAt,
  normalizeGientTransDomTagToken,
  normalizeGientTransInlineMarkup
} from './gientrans-markup.ts';
import type { GientTransMarkupToken } from './gientrans-markup.ts';
import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';

const GIENTRANS_ROOT_SELECTOR = '#o-editor.online-editor';
const GIENTRANS_TABLE_SELECTOR = '.editor__table';
const GIENTRANS_SCROLL_SELECTOR = '.editor__table .el-scrollbar__wrap';
const GIENTRANS_ROW_SELECTOR = '.editor__table tbody > tr.el-table__row';
const GIENTRANS_SOURCE_SELECTOR = 'td.source-cell pre.edit__input[editortype="source"]';
const GIENTRANS_TARGET_SELECTOR = 'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_ROW_NUMBER_SELECTOR = '.sort-index';
const ZERO_WIDTH_EDITOR_MARKERS = /[\u200B\uFEFF\u2060]/g;
const DEBUG_PREFIX = '[Phrase Bulk Fill][GientTrans]';
const MAX_SCAN_DEBUG_LOGS = 12;

export type GientTransTagHtmlLookup = ReadonlyMap<string, readonly string[]>;

interface NativeWriteDiagnostic {
  method: 'beforeinput-paste' | 'insertText' | 'insertHTML' | 'skipped';
  attempted: boolean;
  ok: boolean;
  reason?: string;
  dispatchResult?: boolean;
  defaultPrevented?: boolean;
  execResult?: boolean;
  selected?: boolean;
  before?: ReturnType<typeof describeText>;
  after?: ReturnType<typeof describeText>;
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

export class GientTransAdapter {
  private scanDebugCount = 0;
  private fillDebugSequence = 0;

  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  isActive(): boolean {
    return (
      document.querySelector(GIENTRANS_ROOT_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_TABLE_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_ROW_SELECTOR) !== null
    );
  }

  findScrollContext(): ScrollContext | null {
    const tableScrollContainer = document.querySelector<HTMLElement>(GIENTRANS_SCROLL_SELECTOR);
    if (
      tableScrollContainer &&
      tableScrollContainer.scrollHeight > tableScrollContainer.clientHeight + 8
    ) {
      return this.helpers.toElementScrollContext(tableScrollContainer);
    }

    const candidates = [
      ...Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR)),
      ...Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR))
    ];
    const bestContainer = this.helpers.findBestScrollContainer(candidates);

    return bestContainer ? this.helpers.toElementScrollContext(bestContainer) : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR))
        .filter((row) => this.helpers.isElementVisible(row)),
      scrollContext
    );
    const segments: RuntimeSegment[] = [];

    for (const row of rows) {
      const segment = this.extractRowSegment(row, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    this.debugScan(rows, segments);

    return segments;
  }

  getEditableValue(targetElement: HTMLElement): string {
    return readGientTransEditorText(targetElement);
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const fillId = ++this.fillDebugSequence;
    const currentTarget = this.findCurrentTargetBySegmentId(segment.domId);
    const target = currentTarget ?? (segment.targetElement as HTMLElement);
    this.debug('fill:start', {
      fillId,
      domId: segment.domId,
      rowNumber: segment.rowNumber ?? null,
      foundCurrentTarget: Boolean(currentTarget),
      source: describeText(segment.sourceRaw),
      translation: describeText(value),
      targetBefore: describeText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetAttrs: describeTarget(target)
    });

    if (!this.isWritableTarget(target)) {
      this.debug('fill:skip', {
        fillId,
        reason: 'target-not-writable',
        targetAttrs: describeTarget(target)
      });
      return {
        domId: segment.domId,
        filled: false,
        reason: 'GientTrans target editor is not writable.'
      };
    }

    this.activateTarget(target);
    const tagHtmlByToken = this.collectSourceTagHtmlByToken(target);
    const editorHtml = gientransTextToEditorHtml(value, tagHtmlByToken);
    const containsMappedTags = containsMappedGientTransTag(value, tagHtmlByToken);
    const shouldPreserveEditorHtml = value.includes('\u00A0') || containsMappedTags;
    const nativeWrite = this.writeThroughBeforeInputPaste(target, value, editorHtml);
    let fallbackNativeWrite: NativeWriteDiagnostic;
    let nativeHtmlWrite: NativeWriteDiagnostic | null = null;
    if (nativeWrite.ok) {
      fallbackNativeWrite = nativeWrite;
    } else if (shouldPreserveEditorHtml) {
      fallbackNativeWrite = {
        method: 'skipped' as const,
        attempted: false,
        ok: false,
        reason: containsMappedTags ? 'gientrans-tag-html-path' : 'nbsp-preserve-html-path',
        before: describeText(this.getEditableValue(target))
      };
    } else {
      fallbackNativeWrite = this.writeThroughNativeEditor(target, value);
    }

    if (!fallbackNativeWrite.ok) {
      nativeHtmlWrite = this.writeThroughNativeHtmlEditor(target, value, editorHtml);
      if (nativeHtmlWrite.ok) {
        fallbackNativeWrite = nativeHtmlWrite;
      }
    }

    if (!fallbackNativeWrite.ok) {
      target.innerHTML = editorHtml;
      this.collapseSelectionToEnd(target);
    }

    this.debug('fill:write', {
      fillId,
      nativeWrite,
      fallbackNativeWrite,
      nativeHtmlWrite,
      usedFallbackInnerHtml: !fallbackNativeWrite.ok,
      activeElementMatchesTarget: document.activeElement === target,
      targetAfterWrite: describeText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0
    });

    this.helpers.dispatchInput(target, value);
    this.helpers.dispatchChange(target);
    await delay(20);
    this.helpers.dispatchBlur(target);

    const confirmed = await this.waitForGientTransTextMatch(target, value);

    this.debug('fill:complete', {
      fillId,
      confirmed,
      targetAfterEvents: describeText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetEvents: 'input/change/blur-dispatched'
    });

    return {
      domId: segment.domId,
      filled: confirmed,
      reason: confirmed ? undefined : 'Unable to confirm target update after writing.'
    };
  }

  private extractRowSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const sourceElement = row.querySelector<HTMLElement>(GIENTRANS_SOURCE_SELECTOR);
    const targetElement = row.querySelector<HTMLElement>(GIENTRANS_TARGET_SELECTOR);

    if (!sourceElement || !targetElement) {
      return null;
    }

    const sourceRaw = readGientTransEditorText(sourceElement);
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetElement);
    const rowNumber = normalizeText(
      readGientTransEditorText(row.querySelector<HTMLElement>(GIENTRANS_ROW_NUMBER_SELECTOR))
    );
    const domId =
      targetElement.getAttribute('segid') ||
      sourceElement.getAttribute('segid') ||
      row.getAttribute('data-row-key') ||
      row.id ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      rowNumber: rowNumber || undefined,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement,
      platform: 'gientrans',
      scanElement: row,
      scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
    };
  }

  private findCurrentTargetBySegmentId(segmentId: string): HTMLElement | null {
    return (
      Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR))
        .find((target) => target.getAttribute('segid') === segmentId) ?? null
    );
  }

  private isWritableTarget(target: HTMLElement): boolean {
    return target.isContentEditable || target.getAttribute('contenteditable') === 'true';
  }

  private activateTarget(target: HTMLElement): void {
    const cell = target.closest<HTMLElement>('td.target-cell') ?? target;
    this.helpers.dispatchMouseSequence(cell, ['mousedown', 'mouseup', 'click', 'dblclick']);
    target.focus();
  }

  private writeThroughNativeEditor(target: HTMLElement, value: string): NativeWriteDiagnostic {
    const before = describeText(this.getEditableValue(target));
    if (typeof document.execCommand !== 'function') {
      return {
        method: 'insertText',
        attempted: false,
        ok: false,
        reason: 'execCommand-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    let execResult = false;

    try {
      execResult = document.execCommand('insertText', false, value);
    } catch (error) {
      return {
        method: 'insertText',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'execCommand-threw',
        selected,
        before,
        after: describeText(this.getEditableValue(target))
      };
    }

    const after = describeText(this.getEditableValue(target));
    return {
      method: 'insertText',
      attempted: true,
      ok: after.normalized === normalizeText(value),
      execResult,
      selected,
      before,
      after
    };
  }

  private writeThroughNativeHtmlEditor(
    target: HTMLElement,
    value: string,
    editorHtml: string
  ): NativeWriteDiagnostic {
    const before = describeText(this.getEditableValue(target));
    if (typeof document.execCommand !== 'function') {
      return {
        method: 'insertHTML',
        attempted: false,
        ok: false,
        reason: 'execCommand-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    let execResult = false;

    try {
      execResult = document.execCommand('insertHTML', false, editorHtml);
    } catch (error) {
      return {
        method: 'insertHTML',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'execCommand-threw',
        selected,
        before,
        after: describeText(this.getEditableValue(target))
      };
    }

    return {
      method: 'insertHTML',
      attempted: true,
      ok: this.isTargetTextMatch(target, value),
      execResult,
      selected,
      before,
      after: describeText(this.getEditableValue(target))
    };
  }

  private writeThroughBeforeInputPaste(
    target: HTMLElement,
    value: string,
    editorHtml: string
  ): NativeWriteDiagnostic {
    const before = describeText(this.getEditableValue(target));
    if (typeof InputEvent !== 'function' || typeof DataTransfer !== 'function') {
      return {
        method: 'beforeinput-paste',
        attempted: false,
        ok: false,
        reason: 'beforeinput-paste-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', value);
    dataTransfer.setData('text/segment', editorHtml);
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertFromPaste'
    });

    try {
      Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: dataTransfer
      });
    } catch {
      return {
        method: 'beforeinput-paste',
        attempted: true,
        ok: false,
        reason: 'dataTransfer-unavailable',
        selected,
        before,
        after: describeText(this.getEditableValue(target))
      };
    }

    let dispatchResult = true;
    try {
      dispatchResult = target.dispatchEvent(event);
    } catch (error) {
      return {
        method: 'beforeinput-paste',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'beforeinput-paste-threw',
        selected,
        before,
        after: describeText(this.getEditableValue(target))
      };
    }

    const after = describeText(this.getEditableValue(target));
    return {
      method: 'beforeinput-paste',
      attempted: true,
      ok: this.isTargetTextMatch(target, value),
      dispatchResult,
      defaultPrevented: event.defaultPrevented,
      selected,
      before,
      after
    };
  }

  private async waitForGientTransTextMatch(
    target: HTMLElement,
    expected: string
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.isTargetTextMatch(target, expected)) {
        return true;
      }

      if (attempt < 5) {
        await delay(80);
      }
    }

    return false;
  }

  private selectTargetContents(target: HTMLElement): boolean {
    if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private collapseSelectionToEnd(target: HTMLElement): boolean {
    if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private isTargetTextMatch(target: HTMLElement, expected: string): boolean {
    const normalizedExpected = normalizeGientTransInlineMarkup(stripEditorMarkers(expected));
    if (expected.includes('\u00A0')) {
      return (
        normalizeGientTransInlineMarkup(readGientTransEditorTextPreservingNbsp(target)) ===
        normalizedExpected
      );
    }

    return (
      normalizeText(normalizeGientTransInlineMarkup(this.getEditableValue(target))) ===
      normalizeText(normalizedExpected)
    );
  }

  private collectSourceTagHtmlByToken(target: HTMLElement): Map<string, string[]> {
    const row = target.closest<HTMLElement>(GIENTRANS_ROW_SELECTOR);
    const source = row?.querySelector<HTMLElement>(GIENTRANS_SOURCE_SELECTOR) ?? null;
    return collectGientTransTagHtmlByToken(source);
  }

  private debugScan(rows: HTMLElement[], segments: RuntimeSegment[]): void {
    if (!this.isActive() && rows.length === 0 && segments.length === 0) {
      return;
    }

    if (this.scanDebugCount >= MAX_SCAN_DEBUG_LOGS) {
      return;
    }

    this.scanDebugCount += 1;
    this.debug('scan:visible', {
      scanLog: this.scanDebugCount,
      rowsFound: rows.length,
      segmentsFound: segments.length,
      emptyTargets: segments.filter((segment) => segment.isEmptyTarget).length,
      samples: segments.slice(0, 3).map((segment) => ({
        domId: segment.domId,
        rowNumber: segment.rowNumber ?? null,
        source: describeText(segment.sourceRaw),
        target: describeText(segment.targetRaw),
        isEmptyTarget: segment.isEmptyTarget
      }))
    });
  }

  private debug(label: string, payload: Record<string, unknown>): void {
    console.info(DEBUG_PREFIX, label, payload);
  }
}

function readGientTransEditorText(element: HTMLElement | null): string {
  if (!element) {
    return '';
  }

  return normalizeGientTransEditorText(serializeGientTransEditorText(element));
}

function readGientTransEditorTextPreservingNbsp(element: HTMLElement | null): string {
  if (!element) {
    return '';
  }

  return stripEditorMarkers(serializeGientTransEditorText(element));
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

function collectGientTransTagHtmlByToken(element: HTMLElement | null): Map<string, string[]> {
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
  const candidateTokens = tagMatch.raw === tagMatch.canonical
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

function containsMappedGientTransTag(
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

function stripEditorMarkers(value: string): string {
  return value.replace(ZERO_WIDTH_EDITOR_MARKERS, '');
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

function describeTarget(target: HTMLElement): Record<string, unknown> {
  return {
    tagName: target.tagName,
    className: target.className,
    contenteditable: target.getAttribute('contenteditable'),
    isContentEditable: target.isContentEditable,
    editortype: target.getAttribute('editortype'),
    segid: target.getAttribute('segid')
  };
}

function describeText(value: string): {
  rawLength: number;
  normalizedLength: number;
  normalized: string;
  preview: string;
} {
  const normalized = normalizeText(normalizeGientTransEditorText(value));
  return {
    rawLength: value.length,
    normalizedLength: normalized.length,
    normalized,
    preview: normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
  };
}
