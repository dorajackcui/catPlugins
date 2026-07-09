import { runtimeSendMessage } from './chrome-api.ts';
import { extractPlaceholderTokens } from './qa.ts';
import type { ApiResponse, BackgroundRequest, FillOutcome } from './types.ts';
import {
  containsNoBreakSpace,
  delay,
  normalizeText,
  normalizeTextPreservingNoBreakSpaces
} from './utils.ts';
import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';
import {
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from './memoq-text.ts';

export {
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from './memoq-text.ts';

const MEMOQ_CELL_SELECTOR = '.editor-cell';
const MEMOQ_CONTENT_SELECTOR = '.content-container';
const MEMOQ_HIDDEN_INPUT_SELECTOR = '#editorHiddenInput';
const MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR = 'textarea, input[type="text"]';
const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;
const MEMOQ_COMMIT_CONFIRM_ATTEMPTS = 14;
const MEMOQ_COMMIT_CONFIRM_DELAY_MS = 150;
const MEMOQ_ACTIVATION_DELAY_MS = 20;
// One retry: re-resolve the row and click again when the first write clearly
// landed nowhere (grid re-layout between measuring and clicking).
const MEMOQ_FILL_ATTEMPTS = 2;
// memoQ's virtualized grid re-renders rows asynchronously after scrolling;
// wait until the target's rect stops moving before measuring click
// coordinates.
const MEMOQ_LAYOUT_STABLE_CHECK_DELAY_MS = 70;
const MEMOQ_LAYOUT_STABLE_MAX_CHECKS = 8;

type MemoqAccessibilityTextBoxLike = Pick<
  HTMLInputElement | HTMLTextAreaElement,
  'id' | 'disabled' | 'readOnly' | 'value' | 'textContent'
>;

interface MemoqCommitWaitResult {
  confirmed: boolean;
  lastCurrentTargetText: string;
  lastOriginalTargetText: string;
  rowLookupFound: boolean;
}

interface MemoqVisibleRowDiagnostic {
  rowNumber?: string;
  source: string;
  target: string;
}

export function shouldUseMemoqAccessibilityTextBox(
  textBox: MemoqAccessibilityTextBoxLike,
  options: { requireWritable: boolean }
): boolean {
  if (textBox.id === 'editorHiddenInput') {
    return false;
  }

  if (options.requireWritable && (textBox.disabled || textBox.readOnly)) {
    return false;
  }

  return true;
}

export function readMemoqAccessibilityTextBoxValue(
  textBox: Pick<HTMLInputElement | HTMLTextAreaElement, 'value' | 'textContent'>
): string {
  return normalizeText(textBox.value || textBox.textContent || '');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function chooseMemoqAccessibilityTextBoxes<T extends MemoqAccessibilityTextBoxLike>(
  textBoxes: T[]
): { source: T; target: T } | null {
  const readable = textBoxes.filter((textBox) =>
    shouldUseMemoqAccessibilityTextBox(textBox, { requireWritable: false })
  );
  const source = readable.find((textBox) => textBox.disabled || textBox.readOnly);
  const target = readable.find((textBox) =>
    shouldUseMemoqAccessibilityTextBox(textBox, { requireWritable: true })
  );

  if (!source || !target) {
    return null;
  }

  return { source, target };
}

export class MemoqAdapter {
  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  isActive(): boolean {
    return document.querySelector(MEMOQ_CELL_SELECTOR) !== null;
  }

  findScrollContext(): ScrollContext | null {
    const cells = Array.from(
      document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR)
    ).filter((cell) => this.helpers.isElementVisible(cell));

    const container =
      this.helpers.findBestScrollContainer(cells) ??
      this.findMemoqScrollContainer(cells);

    if (container) {
      return this.helpers.toElementScrollContext(container);
    }

    const interactionTarget = this.findMemoqInteractionTarget(cells);
    if (!interactionTarget) {
      return null;
    }

    return this.createSyntheticScrollContext(interactionTarget);
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const cells = this.helpers.sortByVisualPosition(
      Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
        .filter((cell) => this.helpers.isElementVisible(cell)),
      scrollContext
    );

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

    return this.dedupeVisibleSegments([...rowMap.values()], scrollContext);
  }

  getEditableValue(targetElement: HTMLElement): string {
    if (targetElement.matches(MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR)) {
      return readMemoqAccessibilityTextBoxValue(
        targetElement as HTMLInputElement | HTMLTextAreaElement
      );
    }

    const content = targetElement.querySelector<HTMLElement>(MEMOQ_CONTENT_SELECTOR) || targetElement;
    return serializeMemoqContent(content);
  }

  // Reads the row's target text from the CURRENT DOM. The element captured
  // at scan time may have been recycled by the virtualized grid to show a
  // different row, so pre-fill emptiness checks must re-resolve by row
  // number.
  getCurrentEditableValue(segment: RuntimeSegment): string {
    const currentTargetCell = this.findCurrentMemoqTargetCellByRowNumber(segment.rowNumber);
    return this.getEditableValue(
      (currentTargetCell ?? segment.targetElement) as HTMLElement
    );
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const originalTarget = segment.targetElement as HTMLElement;
    const hiddenInput = document.querySelector<HTMLInputElement>(MEMOQ_HIDDEN_INPUT_SELECTOR);
    if (!hiddenInput) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'memoQ hidden input was not found.'
      };
    }

    // Attach the debugger before resolving or measuring anything: a fresh
    // attachment shows the debugging infobar, which resizes the page and
    // re-lays out memoQ's virtualized grid, invalidating any element or
    // coordinate captured earlier.
    try {
      await this.prepareTrustedInput();
    } catch (error) {
      return {
        domId: segment.domId,
        filled: false,
        reason: `memoQ trusted input is unavailable: ${describeError(error)}`
      };
    }

    const currentTargetBefore = this.findCurrentMemoqTargetCellByRowNumber(segment.rowNumber);
    const originalTargetBeforeText = this.readMemoqElementText(originalTarget);
    const currentTargetBeforeText = currentTargetBefore
      ? this.readMemoqElementText(currentTargetBefore)
      : '';

    let waitResult: MemoqCommitWaitResult = {
      confirmed: false,
      lastCurrentTargetText: '',
      lastOriginalTargetText: '',
      rowLookupFound: false
    };
    let activationFailure: string | undefined;

    // Resolved lazily and repeatedly: the virtualized grid can replace the
    // row's DOM node at any moment (scroll, commit, infobar re-layout), so a
    // reference is only trustworthy at the instant it is measured.
    const resolveTarget = (): HTMLElement =>
      this.findCurrentMemoqTargetCellByRowNumber(segment.rowNumber) ?? originalTarget;

    for (let attempt = 0; attempt < MEMOQ_FILL_ATTEMPTS; attempt += 1) {
      let target: HTMLElement;
      try {
        target = await this.activateTarget(resolveTarget);
        activationFailure = undefined;
      } catch (error) {
        activationFailure = describeError(error);
        continue;
      }

      hiddenInput.focus();
      this.writeValueThroughHiddenInput(hiddenInput, value);

      waitResult = await this.waitForCommittedTargetCellText(
        target,
        value,
        segment.rowNumber
      );

      if (waitResult.confirmed) {
        break;
      }

      // Retry only while the row still shows nothing — if partial or foreign
      // text landed there, a second insert could duplicate content.
      if (waitResult.lastCurrentTargetText !== '') {
        break;
      }
    }

    if (waitResult.confirmed && containsNoBreakSpace(value)) {
      this.warnIfNoBreakSpacesConverted(segment, value);
    }

    let reason: string | undefined;
    if (!waitResult.confirmed) {
      reason = activationFailure
        ? `memoQ target activation failed: ${activationFailure} row=${segment.rowNumber ?? segment.domId} source="${this.truncateDiagnostic(segment.sourceRaw)}"`
        : this.buildMemoqFillFailureReason({
            segment,
            value,
            hiddenInput,
            originalTargetBeforeText,
            currentTargetBeforeText,
            waitResult
          });
    }

    if (reason) {
      console.warn('[Phrase Bulk Fill] memoQ fill confirmation failed', reason);
    }

    return {
      domId: segment.domId,
      filled: waitResult.confirmed,
      reason
    };
  }

  private writeValueThroughHiddenInput(hiddenInput: HTMLInputElement, value: string): void {
    let pasteWasHandled = false;
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', value);
      pasteWasHandled = !hiddenInput.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData
        })
      );
    } catch {
      // Ignore environments where ClipboardEvent cannot be synthesized.
    }

    if (!pasteWasHandled && typeof document.execCommand === 'function') {
      document.execCommand('insertText', false, value);
    }

    this.helpers.setNativeInputValue(hiddenInput, value);
    this.helpers.dispatchInput(hiddenInput, value, true);
    this.helpers.dispatchChange(hiddenInput);
    this.helpers.dispatchBlur(hiddenInput);
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
    const cells = this.helpers.sortByVisualPosition(
      Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
        .filter((cell) => this.helpers.isElementVisible(cell)),
      scrollContext
    );

    if (cells.length < 2) {
      return null;
    }

    const sourceCell = cells[0];
    const targetCell = cells[cells.length - 1];
    const sourceRaw = this.getEditableValue(sourceCell);
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetCell);
    const rowNumber = this.extractMemoqRowNumber(row, scrollContext);
    const domId =
      rowNumber ||
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      rowNumber,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement: targetCell,
      platform: 'memoq',
      scanElement: row,
      scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
    };
  }

  private async waitForCommittedTargetCellText(
    targetCell: HTMLElement,
    value: string,
    rowNumber?: string
  ): Promise<MemoqCommitWaitResult> {
    let lastCurrentTargetText = '';
    let lastOriginalTargetText = '';
    let rowLookupFound = false;

    for (let attempt = 0; attempt < MEMOQ_COMMIT_CONFIRM_ATTEMPTS; attempt += 1) {
      const currentTargetCell = this.findCurrentMemoqTargetCellByRowNumber(rowNumber);
      rowLookupFound = currentTargetCell !== null;
      const committedTargetCell = currentTargetCell ?? targetCell;
      const committedText = this.readMemoqElementRawText(committedTargetCell);
      lastCurrentTargetText = currentTargetCell ? normalizeText(committedText) : '';
      lastOriginalTargetText = this.readMemoqElementText(targetCell);

      if (isMemoqCommittedTargetText(committedText, value)) {
        return {
          confirmed: true,
          lastCurrentTargetText,
          lastOriginalTargetText,
          rowLookupFound
        };
      }

      if (attempt < MEMOQ_COMMIT_CONFIRM_ATTEMPTS - 1) {
        await delay(MEMOQ_COMMIT_CONFIRM_DELAY_MS);
      }
    }

    return {
      confirmed: false,
      lastCurrentTargetText,
      lastOriginalTargetText,
      rowLookupFound
    };
  }

  private buildMemoqFillFailureReason({
    segment,
    value,
    hiddenInput,
    originalTargetBeforeText,
    currentTargetBeforeText,
    waitResult
  }: {
    segment: RuntimeSegment;
    value: string;
    hiddenInput: HTMLInputElement;
    originalTargetBeforeText: string;
    currentTargetBeforeText: string;
    waitResult: MemoqCommitWaitResult;
  }): string {
    const expectedRendered = memoQAccessibilityTextToRenderedText(value);
    const currentTargetAfter =
      this.findCurrentMemoqTargetCellByRowNumber(segment.rowNumber);
    const visibleRows = this.collectVisibleRowDiagnostics(segment.rowNumber, 2)
      .map((row) =>
        `${row.rowNumber ?? '?'} src="${this.truncateDiagnostic(row.source)}" tgt="${this.truncateDiagnostic(row.target)}"`
      )
      .join(' | ');

    return [
      'Unable to confirm memoQ target update after writing.',
      `row=${segment.rowNumber ?? segment.domId}`,
      `source="${this.truncateDiagnostic(segment.sourceRaw)}"`,
      `expected="${this.truncateDiagnostic(value)}"`,
      `expectedRendered="${this.truncateDiagnostic(expectedRendered)}"`,
      `rowLookupFound=${waitResult.rowLookupFound}`,
      `currentBefore="${this.truncateDiagnostic(currentTargetBeforeText)}"`,
      `currentAfter="${this.truncateDiagnostic(currentTargetAfter ? this.readMemoqElementText(currentTargetAfter) : '')}"`,
      `lastCurrent="${this.truncateDiagnostic(waitResult.lastCurrentTargetText)}"`,
      `oldBefore="${this.truncateDiagnostic(originalTargetBeforeText)}"`,
      `oldAfter="${this.truncateDiagnostic(waitResult.lastOriginalTargetText)}"`,
      `hiddenValue="${this.truncateDiagnostic(hiddenInput.value)}"`,
      `active=${this.describeActiveElement()}`,
      `visibleRows=[${visibleRows}]`
    ].join(' ');
  }

  private collectVisibleRowDiagnostics(
    targetRowNumber?: string,
    radius = 2
  ): MemoqVisibleRowDiagnostic[] {
    if (typeof document.querySelectorAll !== 'function') {
      return [];
    }

    const diagnostics: MemoqVisibleRowDiagnostic[] = [];
    const seenRows = new Set<HTMLElement>();
    const cells = Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR));

    for (const cell of cells) {
      const row = this.findMemoqRowContainer(cell);
      if (!row || seenRows.has(row)) {
        continue;
      }

      seenRows.add(row);
      const rowCells = Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
        .sort((left, right) =>
          left.getBoundingClientRect().left - right.getBoundingClientRect().left
        );

      diagnostics.push({
        rowNumber: this.extractMemoqRowNumberWithoutScrollContext(row),
        source: rowCells[0] ? this.getEditableValue(rowCells[0]) : '',
        target: rowCells[rowCells.length - 1]
          ? this.getEditableValue(rowCells[rowCells.length - 1])
          : ''
      });
    }

    if (!targetRowNumber) {
      return diagnostics.slice(-5);
    }

    const targetIndex = diagnostics.findIndex((row) => row.rowNumber === targetRowNumber);
    if (targetIndex === -1) {
      return diagnostics.slice(-5);
    }

    return diagnostics.slice(
      Math.max(0, targetIndex - radius),
      targetIndex + radius + 1
    );
  }

  private describeActiveElement(): string {
    const activeElement = document.activeElement as HTMLElement | null;
    if (!activeElement) {
      return 'none';
    }

    const value =
      activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
        ? activeElement.value
        : activeElement.innerText || activeElement.textContent || '';

    return `${activeElement.tagName.toLowerCase()}#${activeElement.id || ''}.${String(activeElement.className || '').replace(/\s+/g, '.')}:value="${this.truncateDiagnostic(value)}"`;
  }

  private readMemoqElementRawText(element: HTMLElement): string {
    return element.innerText || element.textContent || '';
  }

  // The accessibility textbox is the only channel exposing memoQ's actual
  // stored text; the rendered cell shows plain and no-break spaces
  // identically. Only compare when the textbox clearly holds this row's text.
  private warnIfNoBreakSpacesConverted(segment: RuntimeSegment, value: string): void {
    if (typeof document.querySelectorAll !== 'function') {
      return;
    }

    const pair = chooseMemoqAccessibilityTextBoxes(
      Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR
        )
      )
    );
    const committed = pair ? pair.target.value || pair.target.textContent || '' : '';

    if (!committed || normalizeText(committed) !== normalizeText(value)) {
      return;
    }

    if (
      normalizeTextPreservingNoBreakSpaces(committed) !==
      normalizeTextPreservingNoBreakSpaces(value)
    ) {
      console.warn(
        '[Phrase Bulk Fill] memoQ stored this segment without its no-break spaces',
        {
          row: segment.rowNumber ?? segment.domId,
          expected: value,
          committed
        }
      );
    }
  }

  private readMemoqElementText(element: HTMLElement): string {
    return normalizeText(this.readMemoqElementRawText(element));
  }

  private truncateDiagnostic(value: string, maxLength = 120): string {
    const normalized = normalizeText(value);
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 3)}...`
      : normalized;
  }

  private findCurrentMemoqTargetCellByRowNumber(rowNumber?: string): HTMLElement | null {
    if (!rowNumber) {
      return null;
    }

    if (typeof document.querySelectorAll !== 'function') {
      return null;
    }

    const seenRows = new Set<HTMLElement>();
    const cells = Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR));

    for (const cell of cells) {
      const row = this.findMemoqRowContainer(cell);
      if (!row || seenRows.has(row)) {
        continue;
      }

      seenRows.add(row);

      if (this.extractMemoqRowNumberWithoutScrollContext(row) !== rowNumber) {
        continue;
      }

      // The virtualized grid can keep a zero-size recycled node that still
      // carries this row number; only a cell with a real rect is the live
      // row, so keep scanning past invisible duplicates.
      const rowCells = Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
        .filter((rowCell) => this.hasClickableRect(rowCell))
        .sort((left, right) =>
          left.getBoundingClientRect().left - right.getBoundingClientRect().left
        );

      const targetCell = rowCells[rowCells.length - 1];
      if (targetCell) {
        return targetCell;
      }
    }

    return null;
  }

  private hasClickableRect(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private extractMemoqRowNumberWithoutScrollContext(row: HTMLElement): string | undefined {
    return this.extractMemoqRowNumberFromChildren(
      Array.from(row.children) as HTMLElement[],
      row
    );
  }

  private extractMemoqRowNumber(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): string | undefined {
    const children = this.helpers.sortByVisualPosition(
      Array.from(row.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && this.helpers.isElementVisible(child)
      ),
      scrollContext
    );

    return this.extractMemoqRowNumberFromChildren(children, row);
  }

  private extractMemoqRowNumberFromChildren(
    children: HTMLElement[],
    row: HTMLElement
  ): string | undefined {
    for (const child of children) {
      if (child.matches(MEMOQ_CELL_SELECTOR)) {
        continue;
      }

      const text = normalizeText(child.innerText || child.textContent || '');
      const match = text.match(/^(\d+)\.?$/);
      if (match) {
        return match[1];
      }
    }

    const ariaRowIndex = row.getAttribute('aria-rowindex');
    return ariaRowIndex && /^\d+$/.test(ariaRowIndex) ? ariaRowIndex : undefined;
  }

  private dedupeVisibleSegments(
    segments: RuntimeSegment[],
    scrollContext: ScrollContext
  ): RuntimeSegment[] {
    const deduped = new Map<string, RuntimeSegment>();

    for (const segment of segments) {
      const topBucket = Math.round(
        this.helpers.getAbsoluteTop(segment.targetElement as Element, scrollContext) /
          VISIBLE_SEGMENT_TOP_BUCKET_PX
      );
      const visibleKey = `${segment.sourceNormalized}::${topBucket}`;
      const current = deduped.get(visibleKey);

      if (!current) {
        deduped.set(visibleKey, segment);
        continue;
      }

      const currentTarget = normalizeText(current.targetRaw);
      const nextTarget = normalizeText(segment.targetRaw);
      const shouldReplace =
        currentTarget.length === 0 &&
        nextTarget.length > 0;

      if (shouldReplace) {
        deduped.set(visibleKey, segment);
      }
    }

    return [...deduped.values()];
  }

  private findMemoqScrollContainer(cells: HTMLElement[]): HTMLElement | null {
    if (cells.length === 0) {
      return null;
    }

    const candidateContainers = new Map<
      HTMLElement,
      { score: number; scrollRange: number }
    >();

    for (const cell of cells.slice(0, 40)) {
      let ancestor = cell.parentElement;
      let depth = 0;

      while (ancestor && ancestor !== document.body && depth < 12) {
        const scrollRange = ancestor.scrollHeight - ancestor.clientHeight;
        if (scrollRange > 120) {
          const current = candidateContainers.get(ancestor) ?? {
            score: 0,
            scrollRange
          };
          current.score += Math.max(1, 10 - depth);
          current.scrollRange = Math.max(current.scrollRange, scrollRange);

          const style = window.getComputedStyle(ancestor);
          if (style.overflowY !== 'visible') {
            current.score += 2;
          }

          if (ancestor.querySelectorAll(MEMOQ_CELL_SELECTOR).length > 20) {
            current.score += 3;
          }

          candidateContainers.set(ancestor, current);
        }

        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidateContainers.entries()]
      .sort((left, right) => {
        if (right[1].score !== left[1].score) {
          return right[1].score - left[1].score;
        }

        return right[1].scrollRange - left[1].scrollRange;
      })[0]?.[0] ?? null;
  }

  private findMemoqInteractionTarget(cells: HTMLElement[]): HTMLElement | null {
    const candidates = new Map<HTMLElement, number>();

    for (const cell of cells.slice(0, 40)) {
      let ancestor = cell.parentElement;
      let depth = 0;

      while (ancestor && ancestor !== document.body && depth < 8) {
        const current = candidates.get(ancestor) ?? 0;
        candidates.set(ancestor, current + Math.max(1, 8 - depth));
        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidates.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }

  private createSyntheticScrollContext(target: HTMLElement): ScrollContext {
    let syntheticTop = 0;

    return {
      initialTop: 0,
      mode: 'synthetic',
      getTop: () => syntheticTop,
      getHeight: () => target.clientHeight || window.innerHeight,
      scrollToTop: () => {
        const focusTarget = this.findMemoqFocusTarget(target);

        focusTarget.focus();
        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'Home',
              code: 'Home',
              ctrlKey: true,
              metaKey: true
            })
          );
          receiver.dispatchEvent(
            new KeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'Home',
              code: 'Home',
              ctrlKey: true,
              metaKey: true
            })
          );
        }
        syntheticTop = 0;
      },
      scrollBy: (delta) => {
        const focusTarget = this.findMemoqFocusTarget(target);

        focusTarget.focus();

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: Math.max(delta, 240)
            })
          );
        }

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
          receiver.dispatchEvent(
            new KeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
        }

        syntheticTop += Math.max(delta, 240);
      },
      isAtBottom: () => false,
      restore: () => {
        // Synthetic scrolling cannot be restored reliably.
      }
    };
  }

  private findMemoqFocusTarget(target: HTMLElement): HTMLElement {
    return (
      document.querySelector<HTMLElement>(MEMOQ_HIDDEN_INPUT_SELECTOR) ||
      target.querySelector<HTMLElement>(MEMOQ_CELL_SELECTOR) ||
      target
    );
  }

  private async activateTarget(resolveTarget: () => HTMLElement): Promise<HTMLElement> {
    resolveTarget().scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await delay(MEMOQ_ACTIVATION_DELAY_MS);
    // Scrolling makes the virtualized grid load and re-lay out rows
    // asynchronously — and a re-render can swap the row's DOM node entirely.
    // Re-resolve while waiting so coordinates come from the live node.
    const target = await this.waitForClickableTarget(resolveTarget);
    await this.dispatchTrustedMouseClick(target);
    await delay(MEMOQ_ACTIVATION_DELAY_MS);
    return target;
  }

  // Resolves the target until it reports the same non-zero rect twice in a
  // row. A zero rect is never "stable" — it means the node is detached or
  // hidden, so keep re-resolving until the live replacement shows up.
  private async waitForClickableTarget(resolveTarget: () => HTMLElement): Promise<HTMLElement> {
    let previousKey: string | null = null;
    let candidate = resolveTarget();

    for (let check = 0; check < MEMOQ_LAYOUT_STABLE_MAX_CHECKS; check += 1) {
      await delay(MEMOQ_LAYOUT_STABLE_CHECK_DELAY_MS);
      candidate = resolveTarget();
      const rect = candidate.getBoundingClientRect();
      const key =
        rect.width > 0 && rect.height > 0
          ? `${rect.top}:${rect.left}:${rect.width}:${rect.height}`
          : null;

      if (key !== null && key === previousKey) {
        return candidate;
      }

      previousKey = key;
    }

    return candidate;
  }

  // Attaches the tab debugger (or extends an existing attachment) so trusted
  // clicks can be dispatched. Public so the fill run can attach once up
  // front, before any segment snapshot is collected — the fresh-attachment
  // infobar re-layout then happens before elements are captured.
  async prepareTrustedInput(): Promise<void> {
    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_PREPARE'
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  private async dispatchTrustedMouseClick(targetElement: HTMLElement): Promise<void> {
    const rect = targetElement.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('memoQ target cell is not visible enough to click.');
    }

    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_CLICK',
      payload: {
        x,
        y
      }
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }
}
