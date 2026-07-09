import { runtimeSendMessage } from '../../chrome-api.ts';
import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from '../../content-script-dom.ts';
import { describeMemoqFillDiagnostic } from './fill-diagnostics.ts';
import { MemoqFillTransaction } from './fill-transaction.ts';
import {
  selectMemoqDomProfile,
  type MemoqDomProfile
} from './dom-profile.ts';
import {
  MemoqRowReader,
} from './row-reader.ts';
import {
  chooseMemoqAccessibilityTextBoxes,
  readMemoqAccessibilityTextBoxValue
} from './accessibility-textbox.ts';
import { serializeMemoqContent } from './text.ts';
import { writeTrustedTextToElement } from '../../trusted-text-writer.ts';
import type { ApiResponse, BackgroundRequest, FillOutcome } from '../../types.ts';
import {
  containsNoBreakSpace,
  normalizeText,
  normalizeTextPreservingNoBreakSpaces
} from '../../utils.ts';

export {
  chooseMemoqAccessibilityTextBoxes,
  readMemoqAccessibilityTextBoxValue,
  shouldUseMemoqAccessibilityTextBox
} from './accessibility-textbox.ts';
export {
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from './text.ts';

const MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR = 'textarea, input[type="text"]';

export class MemoqAdapter {
  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  private getProfile(): MemoqDomProfile | null {
    return selectMemoqDomProfile(document);
  }

  private getRowReader(): MemoqRowReader | null {
    const profile = this.getProfile();
    return profile ? new MemoqRowReader({ profile, helpers: this.helpers }) : null;
  }

  isActive(): boolean {
    return this.getProfile() !== null;
  }

  findScrollContext(): ScrollContext | null {
    const profile = this.getProfile();
    if (!profile) {
      return null;
    }

    const profileScrollRoot = profile.findScrollRoot(document);
    if (profileScrollRoot) {
      return this.helpers.toElementScrollContext(profileScrollRoot);
    }

    const syntheticTarget = profile.createSyntheticScrollTarget(document);
    if (syntheticTarget) {
      return this.createSyntheticScrollContext(syntheticTarget);
    }

    const visibleTargets = this.getVisibleProfileTargets(profile);
    const scrollContainer = this.helpers.findBestScrollContainer(visibleTargets);
    if (scrollContainer) {
      return this.helpers.toElementScrollContext(scrollContainer);
    }

    const interactionTarget = this.findSharedAncestor(visibleTargets);
    return interactionTarget ? this.createSyntheticScrollContext(interactionTarget) : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    return this.getRowReader()?.collectVisibleSegments(scrollContext) ?? [];
  }

  getEditableValue(targetElement: HTMLElement): string {
    const reader = this.getRowReader();
    if (reader) {
      return reader.getEditableValue(targetElement);
    }

    if (targetElement.matches(MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR)) {
      return readMemoqAccessibilityTextBoxValue(
        targetElement as HTMLInputElement | HTMLTextAreaElement
      );
    }

    return serializeMemoqContent(targetElement);
  }

  getCurrentEditableValue(segment: RuntimeSegment): string {
    return this.getRowReader()?.getCurrentEditableValue(segment) ??
      this.getEditableValue(segment.targetElement as HTMLElement);
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    return this.fillSegmentWithTransaction(segment, value);
  }

  private async fillSegmentWithTransaction(
    segment: RuntimeSegment,
    value: string
  ): Promise<FillOutcome> {
    const profile = this.getProfile();
    if (!profile) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'memoQ editor profile was not found.'
      };
    }

    const reader = new MemoqRowReader({ profile, helpers: this.helpers });
    const transaction = new MemoqFillTransaction({
      profile,
      readTargetText: (target) => reader.getEditableValue(target),
      readSourceText: (currentSegment) => reader.getCurrentSourceValue(currentSegment),
      collectNearbyRows: (rowNumber) => reader.collectVisibleRowDiagnostics(rowNumber),
      writeTrustedText: (target, text) =>
        writeTrustedTextToElement(target, text, {
          requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
          settleMs: 20,
          resolveElement: () => {
            const currentTarget = reader.findCurrentTargetByRowNumber(segment.rowNumber);
            return currentTarget ? profile.getWriteTarget(currentTarget) : null;
          }
        })
    });
    const outcome = await transaction.fillSegment(segment, value);

    if (outcome.filled) {
      if (containsNoBreakSpace(value)) {
        this.warnIfNoBreakSpacesConverted(segment, value);
      }

      return {
        domId: segment.domId,
        filled: true,
        diagnostic: outcome.diagnostic
      };
    }

    return {
      domId: segment.domId,
      filled: false,
      reason: outcome.diagnostic
        ? describeMemoqFillDiagnostic(outcome.diagnostic)
        : undefined,
      diagnostic: outcome.diagnostic
    };
  }

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

  private getVisibleProfileTargets(profile: MemoqDomProfile): HTMLElement[] {
    const targets: HTMLElement[] = [];

    for (const row of profile.findVisibleRows(document)) {
      const cells = profile.findCells(row);
      targets.push(row);

      if (cells) {
        targets.push(cells.source, cells.target);
      }
    }

    return targets.filter((target) => this.helpers.isElementVisible(target));
  }

  private findSharedAncestor(elements: HTMLElement[]): HTMLElement | null {
    const candidates = new Map<HTMLElement, number>();

    for (const element of elements.slice(0, 40)) {
      let ancestor = element.parentElement;
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
    return target.querySelector<HTMLElement>('[tabindex], textarea, input, [contenteditable="true"]') ??
      target;
  }

  async prepareTrustedInput(): Promise<void> {
    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_PREPARE'
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }
}
