import { runtimeSendMessage } from '../../shared/chrome-api.ts';
import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import { describeMemoqFillDiagnostic } from '../../domain/memoq-fill-diagnostics.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import type { ApiResponse, BackgroundRequest } from '../../shared/message-types.ts';
import { warnIfMemoqNoBreakSpacesConverted } from './accessibility-textbox.ts';
import { selectMemoqDomProfile } from './dom-profile.ts';
import { writeMemoqSegment, type MemoqFillExecutionContext } from './editor-writer.ts';
import { MemoqRowReader } from './row-reader.ts';
import { MemoqScrollContextResolver } from './scroll-context.ts';

export type { MemoqFillExecutionContext } from './editor-writer.ts';
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

const DEBUG_PREFIX = '[Phrase Bulk Fill]';

export class MemoqAdapter {
  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  async withOriginalTags<T>(operation: () => Promise<T>): Promise<T> {
    const button = document.getElementById('gridBtnLongInlineTag');
    if (!button || button.classList.contains('selected')) return operation();
    button.click();
    try {
      return await operation();
    } finally {
      if (button.classList.contains('selected')) button.click();
    }
  }

  findScrollContext(): ScrollContext | null {
    const profile = selectMemoqDomProfile();
    return profile ? new MemoqScrollContextResolver(profile, this.helpers).resolve() : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext, includeEmptySources = false): RuntimeSegment[] {
    const profile = selectMemoqDomProfile();
    return profile ? new MemoqRowReader({ profile, helpers: this.helpers }).collectVisibleSegments(scrollContext, includeEmptySources) : [];
  }

  async fillSegment(segment: RuntimeSegment, value: string, context?: MemoqFillExecutionContext): Promise<FillOutcome> {
    const profile = selectMemoqDomProfile();
    if (!profile) return { domId: segment.domId, filled: false, reason: 'memoQ editor profile was not found.' };

    const reader = new MemoqRowReader({ profile, helpers: this.helpers });
    const outcome = await writeMemoqSegment(profile, reader, segment, value, context);
    if (outcome.filled) {
      console.info(DEBUG_PREFIX, 'memoQ fill:success', outcome.diagnostic);
      warnIfMemoqNoBreakSpacesConverted(segment.rowNumber ?? segment.domId, value);
      return outcome;
    }

    const reason = outcome.diagnostic ? describeMemoqFillDiagnostic(outcome.diagnostic) : outcome.reason;
    console.error(DEBUG_PREFIX, 'memoQ fill:failure', reason, outcome.diagnostic ?? { domId: segment.domId, rowNumber: segment.rowNumber, reason });
    return { ...outcome, reason };
  }

  async prepareTrustedInput(): Promise<void> {
    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({ type: 'MEMOQ_DEBUGGER_PREPARE' });
    if (!response.ok) throw new Error(response.error);
  }
}
