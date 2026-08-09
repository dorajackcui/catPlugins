import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoqMarkerFillPlan,
  type MemoqMarkerFillPlan
} from '../domain/memoq-marker-fill.ts';
import {
  MemoqMarkerFillExecutor,
  MemoqMarkerMaterializationError,
  buildAbsoluteCursorOperations
} from '../platforms/memoq/marker-fill-executor.ts';
import type { DebuggerInputOperation } from '../shared/message-types.ts';

const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;

function makePairedPlan() {
  const result = createMemoqMarkerFillPlan(
    '吾王只能<BlueBold>仰视</>着您。',
    '吾王只能{1>仰视<2}着您。',
    'Mon Roi doit <BlueBold>lever les yeux vers vous</>°!'
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.plan;
}

function makeAdjacentPlan() {
  const result = createMemoqMarkerFillPlan(
    '{First}{Second}X{Third}',
    '<1><2>X<3>',
    '{First}{Second}Y{Third}'
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.plan;
}

function tokenizeEditorAtoms(value: string): string[] {
  const atoms: string[] = [];
  let cursor = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  for (const match of value.matchAll(new RegExp(MEMOQ_MARKER_PATTERN.source, 'g'))) {
    const markerStart = match.index ?? 0;
    atoms.push(
      ...Array.from(segmenter.segment(value.slice(cursor, markerStart)), ({ segment }) =>
        segment
      )
    );
    atoms.push(match[0]);
    cursor = markerStart + match[0].length;
  }

  atoms.push(
    ...Array.from(segmenter.segment(value.slice(cursor)), ({ segment }) => segment)
  );
  return atoms;
}

interface EditorHarnessOptions {
  plan?: MemoqMarkerFillPlan;
  wrongMarker?: boolean;
  noOpMarker?: boolean;
  firstUndo?: 'normal' | 'ignored' | 'delayed';
  driftAfterWaitMs?: number;
}

function createEditorHarness(options: EditorHarnessOptions = {}) {
  const plan = options.plan ?? makePairedPlan();
  const target = {} as HTMLElement;
  const writes: string[] = [];
  const inputCalls: DebuggerInputOperation[][] = [];
  const history: string[] = [];
  const waitDelays: number[] = [];
  let value = '';
  let markerIndex = 0;
  let undoCount = 0;
  let elapsedWaitMs = 0;
  let drifted = false;
  let pendingUndo: { value: string; waitsRemaining: number } | null = null;

  const executor = new MemoqMarkerFillExecutor({
    plan,
    editor: {
      resolveTarget: () => target,
      readCurrentValue: () => value,
      async writeText(_target, text) {
        writes.push(text);
        history.push(value);
        value = text;
      },
      async runInput(_target, operations) {
        inputCalls.push(operations);
        if (operations.some(({ type }) => type === 'undo')) {
          undoCount += 1;
          if (options.firstUndo === 'ignored' && undoCount === 1) {
            return;
          }

          const predecessor = history.pop();
          if (predecessor === undefined) {
            return;
          }

          if (options.firstUndo === 'delayed' && undoCount === 1) {
            pendingUndo = { value: predecessor, waitsRemaining: 2 };
            return;
          }

          value = predecessor;
          return;
        }

        const offset =
          operations.find(
            (operation): operation is Extract<
              DebuggerInputOperation,
              { type: 'moveRight' }
            > => operation.type === 'moveRight'
          )?.count ?? 0;
        const atoms = tokenizeEditorAtoms(value);

        if (operations.some(({ type }) => type === 'deleteForward')) {
          history.push(value);
          atoms.splice(offset, 1);
          value = atoms.join('');
          return;
        }

        if (operations.some(({ type }) => type === 'key')) {
          if (options.noOpMarker) {
            return;
          }

          history.push(value);
          const marker = options.wrongMarker
            ? '<99>'
            : plan.anchors[markerIndex]?.markers.join('');
          if (!marker) {
            throw new Error('Expected the next planned marker.');
          }
          atoms.splice(offset, 0, marker);
          value = atoms.join('');
          markerIndex += 1;
        }
      },
      wait: async (delayMs) => {
        waitDelays.push(delayMs);
        elapsedWaitMs += delayMs;

        if (pendingUndo) {
          pendingUndo.waitsRemaining -= 1;
          if (pendingUndo.waitsRemaining <= 0) {
            value = pendingUndo.value;
            pendingUndo = null;
          }
        }

        if (
          !drifted &&
          options.driftAfterWaitMs !== undefined &&
          elapsedWaitMs >= options.driftAfterWaitMs
        ) {
          value = 'late memoQ drift';
          drifted = true;
        }
      }
    }
  });

  return {
    executor,
    plan,
    writes,
    inputCalls,
    waitDelays,
    undoCount: () => undoCount,
    value: () => value
  };
}

async function captureExecutionError(
  executor: MemoqMarkerFillExecutor
): Promise<unknown> {
  try {
    await executor.execute();
  } catch (error) {
    return error;
  }

  throw new Error('Expected marker execution to fail.');
}

test('MemoqMarkerFillExecutor materializes anchors through absolute navigation', async () => {
  const harness = createEditorHarness();

  await harness.executor.execute();

  assert.deepEqual(harness.writes, [harness.plan.skeletonTarget]);
  assert.equal(harness.value(), harness.plan.expectedTarget);
  assert.equal(harness.inputCalls.length, 4);
  assert.deepEqual(harness.inputCalls[0]?.at(-1), { type: 'deleteForward' });
  assert.deepEqual(harness.inputCalls[1]?.at(-1), { type: 'key', key: 'F9' });
  assert.deepEqual(harness.inputCalls[2]?.at(-1), { type: 'deleteForward' });
  assert.deepEqual(harness.inputCalls[3]?.at(-1), { type: 'key', key: 'F9' });
  assert.equal(
    harness.waitDelays.reduce((total, delayMs) => total + delayMs, 0),
    4500
  );
});

test('MemoqMarkerFillExecutor materializes each adjacent marker sequence with one F9', async () => {
  const harness = createEditorHarness({ plan: makeAdjacentPlan() });

  await harness.executor.execute();

  assert.equal(harness.value(), harness.plan.expectedTarget);
  assert.equal(harness.inputCalls.length, 4);
  assert.deepEqual(harness.plan.anchors[0]?.markers, ['<1>', '<2>']);
  assert.deepEqual(harness.inputCalls[1]?.at(-1), { type: 'key', key: 'F9' });
  assert.deepEqual(
    harness.inputCalls[2]?.find(({ type }) => type === 'moveRight'),
    { type: 'moveRight', count: 3 }
  );
});

test('MemoqMarkerFillExecutor clears partial targets after stable verification fails', async () => {
  const harness = createEditorHarness({ wrongMarker: true });

  let caught: unknown;
  try {
    await harness.executor.execute();
  } catch (error) {
    caught = error;
  }

  assert.equal(caught instanceof MemoqMarkerMaterializationError, true);
  if (!(caught instanceof MemoqMarkerMaterializationError)) {
    throw new Error('Expected marker materialization to fail.');
  }
  assert.equal(caught.rollbackSucceeded, true);
  assert.equal(
    /materializing native marker sequence 1 failed/.test(caught.message),
    true
  );

  assert.equal(harness.value(), '');
  assert.equal(
    harness.inputCalls.some((operations) => operations[0]?.type === 'undo'),
    true
  );
});

test('MemoqMarkerFillExecutor skips a no-op action and rolls back only owned history', async () => {
  const harness = createEditorHarness({ noOpMarker: true });
  const error = await captureExecutionError(harness.executor);

  assert.equal(error instanceof MemoqMarkerMaterializationError, true);
  assert.equal(
    error instanceof MemoqMarkerMaterializationError
      ? error.rollbackSucceeded
      : false,
    true
  );

  assert.equal(harness.value(), '');
  assert.equal(harness.undoCount(), 2);
});

test('MemoqMarkerFillExecutor waits for an exact delayed Undo predecessor', async () => {
  const harness = createEditorHarness({ wrongMarker: true, firstUndo: 'delayed' });
  const error = await captureExecutionError(harness.executor);

  assert.equal(
    error instanceof MemoqMarkerMaterializationError
      ? error.rollbackSucceeded
      : false,
    true
  );

  assert.equal(harness.value(), '');
  assert.equal(harness.undoCount(), 3);
});

test('MemoqMarkerFillExecutor stops rollback after an ignored Undo', async () => {
  const harness = createEditorHarness({ wrongMarker: true, firstUndo: 'ignored' });
  const error = await captureExecutionError(harness.executor);

  assert.equal(
    error instanceof MemoqMarkerMaterializationError
      ? error.rollbackSucceeded
      : true,
    false
  );

  assert.equal(harness.undoCount(), 1);
  assert.equal(harness.value() === '', false);
});

test('MemoqMarkerFillExecutor catches drift during the final exact hold', async () => {
  const harness = createEditorHarness({ driftAfterWaitMs: 3600 });
  const error = await captureExecutionError(harness.executor);

  assert.equal(
    error instanceof MemoqMarkerMaterializationError
      ? error.rollbackSucceeded
      : false,
    true
  );

  assert.equal(harness.value(), '');
});

test('buildAbsoluteCursorOperations does not depend on a prior editor cursor', () => {
  assert.deepEqual(
    buildAbsoluteCursorOperations(7, { type: 'key', key: 'F9' }),
    [
      { type: 'documentHome' },
      { type: 'moveRight', count: 7 },
      { type: 'key', key: 'F9' }
    ]
  );
  assert.deepEqual(
    buildAbsoluteCursorOperations(0, { type: 'deleteForward' }),
    [{ type: 'documentHome' }, { type: 'deleteForward' }]
  );
});
