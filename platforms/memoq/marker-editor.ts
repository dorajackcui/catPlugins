import type { RuntimeSegment } from '../../content/types.ts';
import {
  writeTrustedInputSequenceToElement,
  writeTrustedTextToElement
} from '../../content/trusted-text-writer.ts';
import type { MemoqDomProfile } from './dom-profile-types.ts';
import type { MemoqMarkerEditorPort } from './marker-fill-executor.ts';
import { escapeMemoqPlainTargetText, serializeMemoqContentExact } from './text.ts';

interface MemoqMarkerEditorOptions {
  profile: MemoqDomProfile;
  segment: RuntimeSegment;
  resolveTargetByRowNumber(rowNumber: string): HTMLElement | null;
}

/** DOM and trusted-input boundary. Re-resolve virtualized cells for every operation. */
export function createMemoqMarkerEditor({
  profile,
  segment,
  resolveTargetByRowNumber
}: MemoqMarkerEditorOptions): MemoqMarkerEditorPort {
  const resolveTargetCell = (): HTMLElement | null => segment.rowNumber
    ? resolveTargetByRowNumber(segment.rowNumber)
    : segment.targetElement as HTMLElement;
  const resolveWriteTarget = (): HTMLElement | null => {
    const target = resolveTargetCell();
    return target ? profile.getWriteTarget(target) : null;
  };
  const resolveInputTarget = (): HTMLElement | null => {
    const target = resolveTargetCell();
    return target ? profile.getContentRoot(target) : null;
  };
  const resolveOptions = (resolveElement: () => HTMLElement | null) =>
    segment.rowNumber ? { requireResolvedElement: true, resolveElement } : {};

  return {
    resolveTarget: resolveWriteTarget,
    readCurrentValue: () => {
      const content = resolveInputTarget();
      return content ? serializeMemoqContentExact(content) : null;
    },
    writeText: (target, skeleton) => writeTrustedTextToElement(
      target,
      escapeMemoqPlainTargetText(skeleton),
      {
        requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
        settleMs: 20,
        ...resolveOptions(resolveWriteTarget)
      }
    ),
    runInput: async (_target, operations) => {
      const content = resolveInputTarget();
      if (!content) {
        throw new Error('The memoQ marker input target could not be re-resolved.');
      }
      await writeTrustedInputSequenceToElement(content, operations, {
        settleMs: 20,
        focusPosition: 'text-start',
        ...resolveOptions(resolveInputTarget)
      });
    }
  };
}
