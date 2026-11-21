import {
  countMemoqCursorUnitsBeforeAnchor,
  type MemoqSequentialMarkerPlan
} from '../../domain/memoq-marker-fill.ts';
import type { DebuggerInputOperation } from '../../shared/message-types.ts';
import {
  canonicalMarkerState,
  MemoqMarkerStateMonitor,
  MemoqMarkerTargetChangedError
} from './marker-state-monitor.ts';

export type MemoqMarkerAction = Extract<
  DebuggerInputOperation, { type: 'deleteForward' | 'key' | 'undo' }
>;

export interface MemoqMarkerPosition {
  expectedValue: string;
  /** UTF-16 offset in the serialized editor value. */
  textOffset: number;
  /** Editor atoms from the start of the row for keyboard navigation. */
  cursorOffset: number;
}

export interface MemoqMarkerEditorPort {
  resolveTarget(): HTMLElement | null;
  readCurrentValue(): string | null;
  writeText(target: HTMLElement, text: string): Promise<void>;
  runInput(
    target: HTMLElement,
    action: MemoqMarkerAction,
    position?: MemoqMarkerPosition
  ): Promise<void>;
  wait?(delayMs: number): Promise<void>;
}

export interface MemoqMarkerFillExecutorOptions {
  plan: MemoqSequentialMarkerPlan;
  editor: MemoqMarkerEditorPort;
}

export class MemoqMarkerMaterializationError extends Error {
  constructor(
    message: string,
    readonly rollbackSucceeded: boolean,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'MemoqMarkerMaterializationError';
  }
}

/**
 * Materializes native memoQ markers as a verified transaction. Text is written
 * once with unique anchors; every anchor is then deleted and replaced through
 * native Delete and F9. Position each edit independently of the previous
 * caret and verify its full effect before the next edit.
 */
export class MemoqMarkerFillExecutor {
  private readonly monitor: MemoqMarkerStateMonitor;

  constructor(private readonly options: MemoqMarkerFillExecutorOptions) {
    this.monitor = new MemoqMarkerStateMonitor(options.editor);
  }

  async execute(): Promise<void> {
    const { plan, editor } = this.options;
    let stage = 'writing the marker skeleton';
    const undoPredecessors: string[] = [];

    try {
      const initialValue = editor.readCurrentValue();
      if (initialValue === null || canonicalMarkerState(initialValue) !== '') {
        throw new Error('The memoQ target is no longer exactly empty.');
      }

      undoPredecessors.push('');
      await editor.writeText(this.requireTarget(), plan.skeletonTarget);
      let currentExpected = canonicalMarkerState(plan.skeletonTarget);
      await this.monitor.waitForStableValue(currentExpected, stage);
      let materializedSequenceExpansion = 0;

      for (let index = 0; index < plan.anchors.length; index += 1) {
        const anchor = plan.anchors[index];
        if (!anchor) {
          throw new Error(`Marker anchor ${index + 1} is missing.`);
        }

        const skeletonOffset = countMemoqCursorUnitsBeforeAnchor(
          plan.skeletonTarget,
          anchor.sentinel
        );
        if (skeletonOffset === null) {
          throw new Error(
            `Marker anchor ${index + 1} is not unique in the stable target.`
          );
        }
        const cursorOffset = skeletonOffset + materializedSequenceExpansion;
        const textOffset = currentExpected.indexOf(anchor.sentinel);

        stage = `deleting marker anchor ${index + 1}`;
        const afterDelete = replaceUnique(
          currentExpected,
          anchor.sentinel,
          ''
        );
        undoPredecessors.push(currentExpected);
        await editor.runInput(
          this.requireTarget(),
          { type: 'deleteForward' },
          { expectedValue: currentExpected, textOffset, cursorOffset }
        );
        await this.monitor.waitForEdit(currentExpected, afterDelete, stage);

        stage = `materializing native marker sequence ${index + 1}`;
        const afterMarker = replaceUnique(
          currentExpected,
          anchor.sentinel,
          anchor.markers.join('')
        );
        undoPredecessors.push(afterDelete);
        await editor.runInput(
          this.requireTarget(),
          { type: 'key', key: 'F9' },
          { expectedValue: afterDelete, textOffset, cursorOffset }
        );
        await this.monitor.waitForEdit(afterDelete, afterMarker, stage);
        currentExpected = afterMarker;
        materializedSequenceExpansion += anchor.markers.length - 1;
      }

      if (currentExpected !== canonicalMarkerState(plan.expectedTarget)) {
        throw new Error('The final marker atom stream differs from the planned target.');
      }

      stage = 'holding the final marker target stable';
      await this.monitor.waitForExactHold(currentExpected, stage);
    } catch (error) {
      if (error instanceof MemoqMarkerTargetChangedError) {
        throw new MemoqMarkerMaterializationError(
          `${stage} stopped because the target changed before input. Undo history may belong to another edit.`,
          false,
          error
        );
      }
      const rollbackSucceeded = await this.rollback(undoPredecessors);
      throw new MemoqMarkerMaterializationError(
        `${stage} failed; rollback ${rollbackSucceeded ? 'succeeded' : 'failed'}.`,
        rollbackSucceeded,
        error
      );
    }
  }

  private requireTarget(): HTMLElement {
    const target = this.options.editor.resolveTarget();
    if (!target) {
      throw new Error('The memoQ target could not be re-resolved.');
    }
    return target;
  }

  private async rollback(undoPredecessors: string[]): Promise<boolean> {
    try {
      while (undoPredecessors.length > 0) {
        const currentValue = this.options.editor.readCurrentValue();
        if (currentValue === null) {
          return false;
        }

        const currentState = canonicalMarkerState(currentValue);
        const predecessor = undoPredecessors.pop();
        if (predecessor === undefined) {
          return false;
        }

        if (currentState === predecessor) {
          continue;
        }

        await this.options.editor.runInput(this.requireTarget(), { type: 'undo' });
        await this.monitor.waitForStableValue(
          predecessor,
          'rolling back the marker fill'
        );
      }

      await this.monitor.waitForStableValue('', 'rolling back the marker fill');
      return true;
    } catch {
      return false;
    }
  }
}

export function buildAbsoluteCursorOperations(
  cursorOffset: number,
  action: MemoqMarkerAction
): DebuggerInputOperation[] {
  if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0) {
    throw new Error('Invalid memoQ marker cursor offset.');
  }

  const operations: DebuggerInputOperation[] = [
    { type: 'moveLeft', count: 1 }
  ];
  if (cursorOffset > 0) {
    operations.push({ type: 'moveRight', count: cursorOffset });
  }
  operations.push(action);
  return operations;
}

function replaceUnique(
  value: string,
  sentinel: string,
  replacement: string
): string {
  const index = value.indexOf(sentinel);
  if (index < 0 || value.indexOf(sentinel, index + sentinel.length) >= 0) {
    throw new Error('A memoQ marker anchor is missing or duplicated.');
  }

  return `${value.slice(0, index)}${replacement}${value.slice(index + sentinel.length)}`;
}
