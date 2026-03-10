import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { extractPlaceholderTokens } from './qa.ts';
import type {
  ApiResponse,
  ContentRequest,
  FillOutcome,
  FillRunResult,
  PageSegment,
  PreviewItem,
  TranslationEntry
} from './types.ts';
import { delay, normalizeText } from './utils.ts';

declare global {
  interface Window {
    __phraseBulkFillListenerBound?: boolean;
  }
}

const MAX_SEGMENTS = 500;
const MAX_PASSES = 160;
const SCAN_DELAY_MS = 260;
const SCROLL_RATIO = 0.85;
const MEMOQ_CELL_SELECTOR = '.editor-cell';
const MEMOQ_CONTENT_SELECTOR = '.content-container';
const MEMOQ_HIDDEN_INPUT_SELECTOR = '#editorHiddenInput';
const ROW_SELECTORS = ['.segment-row[role="row"]', '.segment-row', '.twe_segment'];
const SOURCE_ROW_SELECTORS = [
  '.text-area-source-container .te_text_container',
  '.text-area-source-container .te_txt',
  '.twe_source .te_text_container',
  '.twe_source .te_txt'
];
const TARGET_ROW_SELECTORS = [
  '.twe_target .te_text_container',
  '.twe_target .te_txt'
];
const TARGET_ACTIVATION_SELECTORS = [
  '.twe_target .te_text_container',
  '.twe_target .te_textarea_container',
  '.twe_target'
];
const LIVE_INPUT_SELECTORS = [
  '.twe_target input.twe-main-input:not([readonly])',
  '.twe_target textarea:not([readonly])',
  '.twe_target [contenteditable="true"]',
  'input.twe-main-input:not([readonly])',
  'textarea:not([readonly])',
  '[contenteditable="true"]'
];
const SOURCE_SELECTORS = [
  '[data-testid*="source"]',
  '[data-test*="source"]',
  '[data-qa*="source"]',
  '[class*="source"]',
  '[data-testid*="segment-source"]',
  '[class*="segment-source"]'
];
const CONTAINER_SELECTORS = [
  '[data-testid*="segment"]',
  '[data-testid*="row"]',
  '[data-qa*="segment"]',
  '[class*="segment"]',
  '[class*="editor-row"]'
];
const EDITABLE_SELECTORS = [
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-qa*="target"]'
];

type EditableElement = HTMLTextAreaElement | HTMLElement;

interface RuntimeSegment extends PageSegment {
  targetElement: EditableElement;
}

interface ScrollContext {
  initialTop: number;
  getTop(): number;
  getHeight(): number;
  scrollBy(delta: number): void;
  isAtBottom(): boolean;
  restore(): void;
}

class PhraseDomAdapter {
  async scanSegments(): Promise<PageSegment[]> {
    const runtimeSegments = await this.collectSegments();
    return runtimeSegments.map(({ targetElement: _targetElement, ...segment }) => segment);
  }

  async fillAll(entries: TranslationEntry[]): Promise<FillRunResult> {
    const entryLookup = createEntryLookup(entries);
    const runtimeSegments = await this.collectSegments();
    const previewItems: PreviewItem[] = [];
    const filledDomIds: string[] = [];

    for (const segment of runtimeSegments) {
      const item = classifySegment(entryLookup, segment);
      previewItems.push(item);

      if (item.status !== 'ready' || !item.translation) {
        continue;
      }

      const outcome = await this.fillSegment(segment, item.translation);
      if (outcome.filled) {
        filledDomIds.push(outcome.domId);
      }
    }

    const preFillPreview = summarizePreview(previewItems);
    return {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds
    };
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const currentValue = this.getEditableValue(segment.targetElement);
    if (normalizeText(currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'Target is no longer empty.'
      };
    }

    const target = segment.targetElement;

    if (target instanceof HTMLElement && target.matches(MEMOQ_CELL_SELECTOR)) {
      return this.fillMemoqSegment(segment, value);
    }

    if (target instanceof HTMLElement && target.matches('.twe_target')) {
      await this.activateTarget(target);
      const liveInput = this.findLiveInput(target);

      if (liveInput instanceof HTMLInputElement || liveInput instanceof HTMLTextAreaElement) {
        this.setNativeInputValue(liveInput, value);
        liveInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        liveInput.dispatchEvent(new Event('change', { bubbles: true }));
        liveInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
        liveInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
        liveInput.dispatchEvent(new Event('blur', { bubbles: true }));
      } else if (liveInput instanceof HTMLElement && liveInput.isContentEditable) {
        liveInput.textContent = value;
        liveInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        liveInput.dispatchEvent(new Event('change', { bubbles: true }));
        liveInput.dispatchEvent(new Event('blur', { bubbles: true }));
      } else {
        const textContainer =
          target.querySelector<HTMLElement>('.te_text_container') || target;
        textContainer.textContent = value;
        textContainer.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        textContainer.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await delay(80);
      const nextValue = this.getEditableValue(target);
      return {
        domId: segment.domId,
        filled: normalizeText(nextValue) === normalizeText(value),
        reason:
          normalizeText(nextValue) === normalizeText(value)
            ? undefined
            : 'Unable to confirm target update after writing.'
      };
    }

    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      this.setNativeInputValue(target, value);
    } else {
      target.textContent = value;
    }

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.dispatchEvent(new Event('blur', { bubbles: true }));

    return { domId: segment.domId, filled: true };
  }

  private async fillMemoqSegment(
    segment: RuntimeSegment,
    value: string
  ): Promise<FillOutcome> {
    const target = segment.targetElement as HTMLElement;
    await this.activateMemoqTarget(target);

    const hiddenInput = document.querySelector<HTMLInputElement>(MEMOQ_HIDDEN_INPUT_SELECTOR);
    if (!hiddenInput) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'memoQ hidden input was not found.'
      };
    }

    hiddenInput.focus();

    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', value);
      hiddenInput.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData
        })
      );
    } catch {
      // Ignore environments where ClipboardEvent cannot be synthesized.
    }

    if (typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, value);
    }

    this.setNativeInputValue(hiddenInput, value);
    hiddenInput.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText'
      })
    );
    hiddenInput.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText'
      })
    );
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    hiddenInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    hiddenInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    hiddenInput.dispatchEvent(new Event('blur', { bubbles: true }));

    await delay(120);
    const nextValue = this.getEditableValue(target);

    return {
      domId: segment.domId,
      filled: normalizeText(nextValue) === normalizeText(value),
      reason:
        normalizeText(nextValue) === normalizeText(value)
          ? undefined
          : 'Unable to confirm memoQ target update after writing.'
    };
  }

  private async collectSegments(): Promise<RuntimeSegment[]> {
    const scrollContext = this.findScrollContext();
    const seenIds = new Set<string>();
    const occurrenceCounter = new Map<string, number>();
    const segments: RuntimeSegment[] = [];

    try {
      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < MAX_PASSES && segments.length < MAX_SEGMENTS; pass += 1) {
        await delay(SCAN_DELAY_MS);

        const countBefore = segments.length;
        const visibleSegments = this.collectVisibleSegments(scrollContext);
        for (const segment of visibleSegments) {
          if (seenIds.has(segment.domId)) {
            continue;
          }

          seenIds.add(segment.domId);
          const nextOccurrence =
            (occurrenceCounter.get(segment.sourceNormalized) ?? 0) + 1;
          occurrenceCounter.set(segment.sourceNormalized, nextOccurrence);
          segment.occurrenceIndex = nextOccurrence;
          segments.push(segment);
        }

        if (segments.length >= MAX_SEGMENTS) {
          break;
        }

        const discoveredCount = segments.length - countBefore;
        noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;

        const scrollTopBefore = scrollContext.getTop();
        const isAtBottom = scrollContext.isAtBottom();
        const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);

        if (isAtBottom && noNewSegmentsPasses >= 3) {
          break;
        }

        if (!isAtBottom) {
          scrollContext.scrollBy(scrollStep);
        } else {
          scrollContext.scrollBy(Math.max(scrollStep / 2, 120));
        }

        await delay(80);

        const scrollTopAfter = scrollContext.getTop();
        noMovementPasses =
          Math.abs(scrollTopAfter - scrollTopBefore) < 2
            ? noMovementPasses + 1
            : 0;

        if (noMovementPasses >= 5 && noNewSegmentsPasses >= 3) {
          break;
        }
      }

      return segments;
    } finally {
      scrollContext.restore();
    }
  }

  private collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const memoqSegments = this.collectMemoqSegments(scrollContext);
    if (memoqSegments.length > 0) {
      return memoqSegments;
    }

    const rowSegments = this.collectRowSegments(scrollContext);
    if (rowSegments.length > 0) {
      return rowSegments;
    }

    const editables = Array.from(
      document.querySelectorAll<EditableElement>(EDITABLE_SELECTORS.join(','))
    )
      .filter((element) => this.isEditableCandidate(element))
      .sort((left, right) => {
        return this.getAbsoluteTop(left, scrollContext) - this.getAbsoluteTop(right, scrollContext);
      });

    const segments: RuntimeSegment[] = [];

    for (const editable of editables) {
      const segment = this.extractSegment(editable, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }

  private collectMemoqSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const cells = Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
      .filter((cell) => this.isElementVisible(cell));

    if (cells.length === 0) {
      return [];
    }

    const rowMap = new Map<HTMLElement, RuntimeSegment>();

    for (const cell of cells) {
      const row = this.findMemoqRowContainer(cell);
      if (!row || rowMap.has(row)) {
        continue;
      }

      const segment = this.extractMemoqSegment(row, scrollContext);
      if (segment) {
        rowMap.set(row, segment);
      }
    }

    return [...rowMap.values()];
  }

  private findMemoqRowContainer(cell: HTMLElement): HTMLElement | null {
    let cursor: HTMLElement | null = cell.parentElement;

    while (cursor && cursor !== document.body) {
      const editorCellCount = cursor.querySelectorAll(MEMOQ_CELL_SELECTOR).length;
      if (editorCellCount >= 2) {
        return cursor;
      }

      cursor = cursor.parentElement;
    }

    return null;
  }

  private extractMemoqSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
      .filter((cell) => this.isElementVisible(cell))
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const topDiff = this.getAbsoluteTop(left, scrollContext) - this.getAbsoluteTop(right, scrollContext);

        if (Math.abs(topDiff) > 2) {
          return topDiff;
        }

        return leftRect.left - rightRect.left;
      });

    if (cells.length < 2) {
      return null;
    }

    const sourceCell = cells[0];
    const targetCell = cells[cells.length - 1];
    const sourceRaw = this.readMemoqCellText(sourceCell);
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.readMemoqCellText(targetCell);
    const domId =
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement: targetCell
    };
  }

  private readMemoqCellText(cell: HTMLElement): string {
    const content = cell.querySelector<HTMLElement>(MEMOQ_CONTENT_SELECTOR) || cell;
    return normalizeText(content.innerText || content.textContent || '');
  }

  private collectRowSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTORS.join(',')))
      .filter((row) => this.isElementVisible(row))
      .sort((left, right) => {
        return this.getAbsoluteTop(left, scrollContext) - this.getAbsoluteTop(right, scrollContext);
      });

    const segments: RuntimeSegment[] = [];

    for (const row of rows) {
      const segment = this.extractRowSegment(row, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }

  private extractRowSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const targetElement = row.querySelector<HTMLElement>('.twe_target');
    if (!targetElement) {
      return null;
    }

    const sourceRaw = this.readTextBySelectors(row, SOURCE_ROW_SELECTORS);
    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.readTextBySelectors(row, TARGET_ROW_SELECTORS);
    const domId =
      row.id ||
      row.getAttribute('data-position') ||
      `${sourceNormalized}::${Math.round(this.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement
    };
  }

  private extractSegment(
    targetElement: EditableElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const container = this.findSegmentContainer(targetElement);
    const sourceRaw = this.findSourceText(container, targetElement);
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetElement);
    const absoluteTop = this.getAbsoluteTop(targetElement, scrollContext);
    const domId = `${sourceNormalized}::${Math.round(absoluteTop)}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement
    };
  }

  private findSegmentContainer(targetElement: EditableElement): HTMLElement {
    for (const selector of CONTAINER_SELECTORS) {
      const candidate = targetElement.closest<HTMLElement>(selector);
      if (candidate) {
        return candidate;
      }
    }

    let cursor: HTMLElement | null = targetElement.parentElement;
    let depth = 0;
    while (cursor && depth < 6) {
      if (cursor.textContent && normalizeText(cursor.textContent).length > 0) {
        return cursor;
      }
      cursor = cursor.parentElement;
      depth += 1;
    }

    return document.body;
  }

  private findSourceText(container: HTMLElement, targetElement: EditableElement): string {
    for (const selector of SOURCE_SELECTORS) {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
      for (const node of nodes) {
        if (node === targetElement || node.contains(targetElement)) {
          continue;
        }

        const text = normalizeText(node.innerText || node.textContent || '');
        if (text) {
          return text;
        }
      }
    }

    const fragments: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const parent = node.parentElement;
      const textContent = normalizeText(node.textContent ?? '');

      if (
        parent &&
        !targetElement.contains(parent) &&
        !parent.contains(targetElement) &&
        this.isElementVisible(parent) &&
        textContent
      ) {
        fragments.push(textContent);
      }

      node = walker.nextNode();
    }

    return normalizeText(fragments.join(' '));
  }

  private getEditableValue(targetElement: EditableElement): string {
    if (targetElement instanceof HTMLElement && targetElement.matches(MEMOQ_CELL_SELECTOR)) {
      return this.readMemoqCellText(targetElement);
    }

    if (targetElement instanceof HTMLElement && targetElement.matches('.twe_target')) {
      return this.readTextBySelectors(targetElement, TARGET_ROW_SELECTORS);
    }

    if (targetElement instanceof HTMLTextAreaElement) {
      return targetElement.value ?? '';
    }

    return targetElement.textContent ?? '';
  }

  private readTextBySelectors(root: ParentNode, selectors: string[]): string {
    for (const selector of selectors) {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) {
        continue;
      }

      const text = normalizeText(node.innerText || node.textContent || '');
      if (text) {
        return text;
      }
    }

    return '';
  }

  private isEditableCandidate(element: EditableElement): boolean {
    if (!this.isElementVisible(element)) {
      return false;
    }

    if (element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }

    return element.isContentEditable;
  }

  private isElementVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private getAbsoluteTop(element: Element, scrollContext: ScrollContext): number {
    const rect = element.getBoundingClientRect();
    return scrollContext.getTop() + rect.top;
  }

  private findScrollContext(): ScrollContext {
    const editables = Array.from(
      document.querySelectorAll<HTMLElement>(
        [...ROW_SELECTORS, ...EDITABLE_SELECTORS, '.twe_target', MEMOQ_CELL_SELECTOR].join(',')
      )
    );

    const scoredAncestors = new Map<HTMLElement, number>();
    for (const editable of editables) {
      let ancestor = editable.parentElement;
      while (ancestor && ancestor !== document.body) {
        if (ancestor.scrollHeight > ancestor.clientHeight + 120) {
          const currentScore = scoredAncestors.get(ancestor) ?? 0;
          scoredAncestors.set(ancestor, currentScore + 1);
        }
        ancestor = ancestor.parentElement;
      }
    }

    const bestContainer = [...scoredAncestors.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0];

    if (bestContainer) {
      const initialTop = bestContainer.scrollTop;
      return {
        initialTop,
        getTop: () => bestContainer.scrollTop,
        getHeight: () => bestContainer.clientHeight || window.innerHeight,
        scrollBy: (delta) => bestContainer.scrollBy({ top: delta, behavior: 'auto' }),
        isAtBottom: () =>
          bestContainer.scrollTop + bestContainer.clientHeight >=
          bestContainer.scrollHeight - 8,
        restore: () => bestContainer.scrollTo({ top: initialTop, behavior: 'auto' })
      };
    }

    const initialTop = window.scrollY;
    return {
      initialTop,
      getTop: () => window.scrollY,
      getHeight: () => window.innerHeight,
      scrollBy: (delta) => window.scrollBy({ top: delta, behavior: 'auto' }),
      isAtBottom: () =>
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8,
      restore: () => window.scrollTo({ top: initialTop, behavior: 'auto' })
    };
  }

  private async activateMemoqTarget(targetElement: HTMLElement): Promise<void> {
    for (const eventName of ['mousedown', 'mouseup', 'click']) {
      targetElement.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }

    targetElement.focus();
    await delay(80);
  }

  private async activateTarget(targetElement: HTMLElement): Promise<void> {
    const clickTarget =
      targetElement.querySelector<HTMLElement>(TARGET_ACTIVATION_SELECTORS.join(',')) ||
      targetElement;

    for (const eventName of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      clickTarget.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }

    clickTarget.focus();
    await delay(80);
  }

  private findLiveInput(targetElement: HTMLElement): EditableElement | null {
    const row = targetElement.closest<HTMLElement>(ROW_SELECTORS.join(','));
    const scopedRoots = [targetElement, row, document.body].filter(
      (value): value is HTMLElement => Boolean(value)
    );

    for (const root of scopedRoots) {
      for (const selector of LIVE_INPUT_SELECTORS) {
        const input = root.querySelector<EditableElement>(selector);
        if (!input) {
          continue;
        }

        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
          if (!input.readOnly && !input.disabled) {
            return input;
          }
          continue;
        }

        if (input.isContentEditable) {
          return input;
        }
      }
    }

    return null;
  }

  private setNativeInputValue(
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void {
    const prototype = Object.getPrototypeOf(input) as HTMLInputElement | HTMLTextAreaElement;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }
}

const adapter = new PhraseDomAdapter();

async function handleRequest(request: ContentRequest): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'CONTENT_SCAN': {
      const segments = await adapter.scanSegments();
      return { ok: true, data: segments };
    }

    case 'CONTENT_FILL': {
      const result = await adapter.fillAll(request.payload.entries);
      return { ok: true, data: result };
    }

    default: {
      return { ok: false, error: 'Unsupported content-script request.' };
    }
  }
}

if (!window.__phraseBulkFillListenerBound) {
  chrome.runtime.onMessage.addListener(
    (
      request: ContentRequest,
      _sender: unknown,
      sendResponse: (response: ApiResponse<unknown>) => void
    ) => {
      void (async () => {
        try {
          sendResponse(await handleRequest(request));
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown content-script error.'
          });
        }
      })();

      return true;
    }
  );

  window.__phraseBulkFillListenerBound = true;
}
