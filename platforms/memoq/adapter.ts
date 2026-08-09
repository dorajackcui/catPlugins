import { runtimeSendMessage } from '../../shared/chrome-api.ts';
import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import { describeMemoqFillDiagnostic } from '../../domain/memoq-fill-diagnostics.ts';
import { MemoqFillTransaction } from './fill-transaction.ts';
import {
  selectMemoqDomProfile,
  type MemoqDomProfile
} from './dom-profile.ts';
import { MemoqRowReader } from './row-reader.ts';
import { MemoqScrollContextResolver } from './scroll-context.ts';
import {
  chooseMemoqAccessibilityTextBoxes,
  readMemoqAccessibilityTextBoxValue
} from './accessibility-textbox.ts';
import { serializeMemoqContent } from './text.ts';
import {
  writeTrustedInputSequenceToElement,
  writeTrustedTextToElement
} from '../../content/trusted-text-writer.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation
} from '../../shared/message-types.ts';
import type { MemoqMarkerFillPlan } from '../../domain/memoq-marker-fill.ts';
import { hasMemoqInlineTagMarkup } from '../../domain/memoq-markup.ts';
import {
  containsNoBreakSpace,
  normalizeText,
  normalizeTextPreservingNoBreakSpaces
} from '../../shared/utils.ts';

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
const MEMOQ_DEBUG_PREFIX = '[Phrase Bulk Fill]';

export interface MemoqFillExecutionContext {
  runId: string;
  sequence: number;
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
  markerFillPlan?: MemoqMarkerFillPlan;
}

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

    return new MemoqScrollContextResolver(profile, this.helpers).resolve();
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

  async fillSegment(
    segment: RuntimeSegment,
    value: string,
    context?: MemoqFillExecutionContext
  ): Promise<FillOutcome> {
    return this.fillSegmentWithTransaction(segment, value, context);
  }

  private async fillSegmentWithTransaction(
    segment: RuntimeSegment,
    value: string,
    context?: MemoqFillExecutionContext
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
    const markerFillPlan = context?.markerFillPlan;
    const transaction = new MemoqFillTransaction({
      profile,
      readTargetText: (target) => reader.getEditableValue(target),
      readSourceText: (currentSegment) => reader.getCurrentSourceValue(currentSegment),
      resolveCurrentTarget: (rowNumber) => reader.findCurrentTargetByRowNumber(rowNumber),
      collectNearbyRows: (rowNumber) => reader.collectVisibleRowDiagnostics(rowNumber),
      writeTrustedText: (target, text) => {
        const resolveOptions = segment.rowNumber
          ? {
              requireResolvedElement: true,
              resolveElement: () => {
                const currentTarget = reader.findCurrentTargetByRowNumber(segment.rowNumber);
                return currentTarget ? profile.getWriteTarget(currentTarget) : null;
              }
            }
          : {};

        if (markerFillPlan) {
          return writeTrustedInputSequenceToElement(
            target,
            toDebuggerMarkerOperations(markerFillPlan),
            {
              settleMs: 20,
              ...resolveOptions
            }
          );
        }

        if (hasMemoqInlineTagMarkup(segment.sourceRaw)) {
          throw new Error('memoQ marker fill requires an explicit experimental marker plan.');
        }

        return writeTrustedTextToElement(target, text, {
          requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
          settleMs: 20,
          ...resolveOptions
        });
      },
      expectedCommittedValue: markerFillPlan?.expectedTarget,
      runId: context?.runId,
      sequence: context?.sequence,
      scanPass: context?.scanPass,
      scrollTop: context?.scrollTop,
      scrollMode: context?.scrollMode
    });
    const outcome = await transaction.fillSegment(segment, value);

    if (outcome.filled) {
      console.info(MEMOQ_DEBUG_PREFIX, 'memoQ fill:success', outcome.diagnostic);
    } else {
      console.error(MEMOQ_DEBUG_PREFIX, 'memoQ fill:failure', outcome.diagnostic ?? {
        rowNumber: segment.rowNumber,
        domId: segment.domId,
        reason: outcome.reason
      });
    }

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

  async prepareTrustedInput(): Promise<void> {
    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_PREPARE'
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }
}

function toDebuggerMarkerOperations(
  plan: MemoqMarkerFillPlan
): DebuggerInputOperation[] {
  const operations: DebuggerInputOperation[] = [];

  for (const operation of plan.operations) {
    if (operation.type === 'text') {
      operations.push({ type: 'text', text: operation.text });
      continue;
    }

    operations.push({ type: 'key', key: 'F9' });
    operations.push({ type: 'wait', milliseconds: 80 });
  }

  return operations;
}
