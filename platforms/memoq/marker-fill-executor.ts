import {
  countMemoqCursorUnitsBeforeAnchor,
  type MemoqMarkerFillPlan
} from '../../domain/memoq-marker-fill.ts';
import type { DebuggerInputOperation } from '../../shared/message-types.ts';

const STABLE_MATCHES_REQUIRED = 6;
const STABLE_READ_ATTEMPTS = 24;
const STABLE_READ_DELAY_MS = 120;
const FINAL_EXACT_HOLD_MS = 1500;

export interface MemoqMarkerEditorPort {
  resolveTarget(): HTMLElement | null;
  readCurrentValue(): string | null;
  writeText(target: HTMLElement, text: string): Promise<void>;
  runInput(
    target: HTMLElement,
    operations: DebuggerInputOperation[]
  ): Promise<void>;
  wait?(delayMs: number): Promise<void>;
}

export interface MemoqMarkerFillExecutorOptions {
  plan: MemoqMarkerFillPlan;
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
 * native keyboard navigation plus F9. No step relies on the previous cursor.
 */
export class MemoqMarkerFillExecutor {
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(private readonly options: MemoqMarkerFillExecutorOptions) {
    this.wait = options.editor.wait ?? waitForMarkerState;
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
      await this.waitForStableValue(currentExpected, stage);
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

        stage = `deleting marker anchor ${index + 1}`;
        const afterDelete = replaceUnique(
          currentExpected,
          anchor.sentinel,
          ''
        );
        undoPredecessors.push(currentExpected);
        await editor.runInput(
          this.requireTarget(),
          buildAbsoluteCursorOperations(cursorOffset, { type: 'deleteForward' })
        );
        await this.waitForStableValue(afterDelete, stage);

        stage = `materializing native marker sequence ${index + 1}`;
        const afterMarker = replaceUnique(
          currentExpected,
          anchor.sentinel,
          anchor.markers.join('')
        );
        undoPredecessors.push(afterDelete);
        await editor.runInput(
          this.requireTarget(),
          buildAbsoluteCursorOperations(cursorOffset, {
            type: 'key',
            key: 'F9'
          })
        );
        await this.waitForStableValue(afterMarker, stage);
        currentExpected = afterMarker;
        materializedSequenceExpansion += anchor.markers.length - 1;
      }

      if (currentExpected !== canonicalMarkerState(plan.expectedTarget)) {
        throw new Error('The final marker atom stream differs from the planned target.');
      }

      stage = 'holding the final marker target stable';
      await this.waitForExactHold(currentExpected, stage);
    } catch (error) {
      const rollbackSucceeded = await this.rollback(undoPredecessors);
      throw new MemoqMarkerMaterializationError(
        `${stage} failed; rollback ${rollbackSucceeded ? 'succeeded' : 'failed'}.`,
        rollbackSucceeded,
        error
      );
    }
  }

  private async waitForExactHold(
    expected: string,
    stage: string
  ): Promise<void> {
    let heldForMs = 0;

    while (heldForMs < FINAL_EXACT_HOLD_MS) {
      const observed = this.options.editor.readCurrentValue();
      if (
        observed === null ||
        canonicalMarkerState(observed) !== expected
      ) {
        throw new Error(`${stage} changed before the hold window completed.`);
      }

      const delayMs = Math.min(
        STABLE_READ_DELAY_MS,
        FINAL_EXACT_HOLD_MS - heldForMs
      );
      await this.wait(delayMs);
      heldForMs += delayMs;
    }

    const finalObserved = this.options.editor.readCurrentValue();
    if (
      finalObserved === null ||
      canonicalMarkerState(finalObserved) !== expected
    ) {
      throw new Error(`${stage} changed at the end of the hold window.`);
    }
  }

  private requireTarget(): HTMLElement {
    const target = this.options.editor.resolveTarget();
    if (!target) {
      throw new Error('The memoQ target could not be re-resolved.');
    }
    return target;
  }

  private async waitForStableValue(
    expected: string,
    stage: string
  ): Promise<void> {
    let consecutiveMatches = 0;
    let lastObserved = '';

    for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
      const observed = this.options.editor.readCurrentValue();
      if (observed === null) {
        lastObserved = '<target unavailable>';
        consecutiveMatches = 0;
      } else {
        lastObserved = canonicalMarkerState(observed);
        consecutiveMatches =
          lastObserved === expected ? consecutiveMatches + 1 : 0;
      }

      if (consecutiveMatches >= STABLE_MATCHES_REQUIRED) {
        return;
      }

      if (attempt < STABLE_READ_ATTEMPTS) {
        await this.wait(STABLE_READ_DELAY_MS);
      }
    }

    throw new Error(
      `${stage} did not stabilize. Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(lastObserved)}.`
    );
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

        await this.options.editor.runInput(this.requireTarget(), [
          { type: 'undo' }
        ]);
        await this.waitForStableValue(
          predecessor,
          'rolling back the marker fill'
        );
      }

      await this.waitForStableValue('', 'rolling back the marker fill');
      return true;
    } catch {
      return false;
    }
  }
}

export function buildAbsoluteCursorOperations(
  cursorOffset: number,
  action: Extract<DebuggerInputOperation, { type: 'deleteForward' | 'key' }>
): DebuggerInputOperation[] {
  if (!Number.isSafeInteger(cursorOffset) || cursorOffset < 0) {
    throw new Error('Invalid memoQ marker cursor offset.');
  }

  const operations: DebuggerInputOperation[] = [{ type: 'documentHome' }];
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

function canonicalMarkerState(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function waitForMarkerState(delayMs: number): Promise<void> {
  const setTimer =
    typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);

  return new Promise((resolve) => {
    setTimer(resolve, delayMs);
  });
}
