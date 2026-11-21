import { writeTrustedTextToElement } from '../../content/trusted-text-writer.ts';
import type { RuntimeSegment } from '../../content/types.ts';
import { hasMemoqInlineTagMarkup } from '../../domain/memoq-markup.ts';
import type { MemoqMarkerFillPlan } from '../../domain/memoq-marker-fill.ts';
import type { FillOutcome, MemoqFillTrace } from '../../shared/fill-outcome-types.ts';
import { supportsWebTransInput, type MemoqDomProfile } from './dom-profile.ts';
import { MemoqFillTransaction } from './fill-transaction.ts';
import { createMemoqMarkerEditor } from './marker-editor.ts';
import { MemoqMarkerFillExecutor } from './marker-fill-executor.ts';
import type { MemoqRowReader } from './row-reader.ts';
import { escapeMemoqPlainTargetText, isMemoqCommittedTargetText, matchesMemoqNativeTarget, serializeMemoqContentExact } from './text.ts';
import { writeWebTransTarget } from './webtrans-input.ts';

export interface MemoqFillExecutionContext extends MemoqFillTrace {
  markerFillPlan?: MemoqMarkerFillPlan;
}

/** Route a validated translation through the editor currently displaying its row. */
export async function writeMemoqSegment(
  profile: MemoqDomProfile, reader: MemoqRowReader, segment: RuntimeSegment,
  value: string, context?: MemoqFillExecutionContext
): Promise<FillOutcome> {
  const { markerFillPlan: plan, ...trace } = context ?? {};
  const useWebTrans = supportsWebTransInput(profile);
  if (plan?.method === 'webtrans' && !useWebTrans) {
    return { domId: segment.domId, filled: false, reason: 'The webTrans marker input is no longer available.' };
  }

  const resolveTarget = (rowNumber: string) => reader.findCurrentTargetByRowNumber(rowNumber);
  const resolveWriteTarget = () => {
    const cell = segment.rowNumber ? resolveTarget(segment.rowNumber) : segment.targetElement;
    return cell ? profile.getWriteTarget(cell) : null;
  };
  const matchesWebTransTarget = (cell: HTMLElement, expected: string) => {
    const content = profile.getContentRoot(cell);
    return plan ? matchesMemoqNativeTarget(content, expected)
      : !content.querySelector('.tag') && isMemoqCommittedTargetText(serializeMemoqContentExact(content), expected);
  };

  const transaction = new MemoqFillTransaction({
    ...trace,
    profile,
    readSourceText: current => reader.getCurrentSourceValue(current),
    readTargetText: target => reader.getEditableValue(target),
    resolveCurrentTarget: resolveTarget,
    collectNearbyRows: rowNumber => reader.collectVisibleRowDiagnostics(rowNumber),
    expectedCommittedValue: plan?.expectedTarget,
    matchesCommittedTarget: useWebTrans ? matchesWebTransTarget : undefined,
    writeTrustedText(target, text) {
      if (!plan && hasMemoqInlineTagMarkup(segment.sourceRaw)) {
        throw new Error('The memoQ source markers must be matched before writing this target.');
      }
      if (useWebTrans) {
        return writeWebTransTarget({
          target,
          resolveTarget: resolveWriteTarget,
          getContentRoot: cell => profile.getContentRoot(cell),
          sourceMatches: () => reader.matchesCurrentMarkerSource(segment),
          matchesTarget: matchesWebTransTarget,
          expected: plan?.expectedTarget ?? text
        });
      }
      if (plan?.method === 'f9') {
        const editor = createMemoqMarkerEditor({ profile, segment, resolveTargetByRowNumber: resolveTarget });
        return new MemoqMarkerFillExecutor({ plan, editor }).execute();
      }
      return writeTrustedTextToElement(target, escapeMemoqPlainTargetText(text), {
        requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
        settleMs: 20,
        ...(segment.rowNumber && { requireResolvedElement: true, resolveElement: resolveWriteTarget })
      });
    }
  });
  return transaction.fillSegment(segment, value);
}
