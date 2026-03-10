import { extractPlaceholderTokens } from './qa.ts';
import type { FillOutcome } from './types.ts';
import { delay, normalizeText } from './utils.ts';
import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';

const MEMOQ_CELL_SELECTOR = '.editor-cell';
const MEMOQ_CONTENT_SELECTOR = '.content-container';
const MEMOQ_HIDDEN_INPUT_SELECTOR = '#editorHiddenInput';
const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;

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
    const content = targetElement.querySelector<HTMLElement>(MEMOQ_CONTENT_SELECTOR) || targetElement;
    return normalizeText(content.innerText || content.textContent || '');
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const target = segment.targetElement as HTMLElement;
    await this.activateTarget(target);

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

    this.helpers.setNativeInputValue(hiddenInput, value);
    this.helpers.dispatchInput(hiddenInput, value, true);
    this.helpers.dispatchChange(hiddenInput);
    this.helpers.dispatchTabNavigation(hiddenInput);
    this.helpers.dispatchBlur(hiddenInput);

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
    const domId =
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
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
      scrollBy: (delta) => {
        const hiddenInput = document.querySelector<HTMLInputElement>(MEMOQ_HIDDEN_INPUT_SELECTOR);
        const focusTarget =
          hiddenInput ||
          target.querySelector<HTMLElement>(MEMOQ_CELL_SELECTOR) ||
          target;

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

  private async activateTarget(targetElement: HTMLElement): Promise<void> {
    this.helpers.dispatchMouseSequence(targetElement, ['mousedown', 'mouseup', 'click']);
    targetElement.focus();
    await delay(80);
  }
}
