import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoqMarkerFillPlan,
  type MemoqSequentialMarkerPlan
} from '../domain/memoq-marker-fill.ts';
import {
  MemoqMarkerFillExecutor,
  MemoqMarkerMaterializationError,
  buildAbsoluteCursorOperations
} from '../platforms/memoq/marker-fill-executor.ts';
import { MemoqMarkerTargetChangedError } from '../platforms/memoq/marker-state-monitor.ts';
import type { DebuggerInputOperation } from '../shared/message-types.ts';

const MEMOQ_MARKER_PATTERN = /\{\d+>|<\d+\}|<\d+>/g;

function sequentialPlan(source: string, native: string, target: string): MemoqSequentialMarkerPlan {
  const result = createMemoqMarkerFillPlan(source, native, target);
  if (!result.ok) throw new Error(result.reason);
  if (result.plan.method !== 'f9') throw new Error('Expected a sequential marker plan.');
  return result.plan;
}

function makePairedPlan() {
  return sequentialPlan(
    '吾王只能<BlueBold>仰视</>着您。',
    '吾王只能{1>仰视<2}着您。',
    'Mon Roi doit <BlueBold>lever les yeux vers vous</>°!'
  );
}

function makeAdjacentPlan() {
  return sequentialPlan(
    '{First}{Second}X{Third}',
    '<1><2>X<3>',
    '{First}{Second}Y{Third}'
  );
}

function makeFlattenedFileTagPlan() {
  return sequentialPlan(
    '技能冷却时间降低<span color=\\"#FF8E33\\">5</>秒。',
    '技能冷却时间降低<1>5<2>秒。',
    'スキルのクールタイムが<span color=\\"#FF8E33\\">5</>秒短縮される。'
  );
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
  plan?: MemoqSequentialMarkerPlan;
  directCaret?: boolean;
  sourceGroups?: string[];
  wrongMarker?: boolean;
  noOpMarker?: boolean;
  firstUndo?: 'normal' | 'ignored' | 'delayed';
  driftAfterWaitMs?: number;
  changeBeforeInput?: string;
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
      async runInput(_target, action, position) {
        if (position && options.changeBeforeInput) {
          value = options.changeBeforeInput;
          throw new MemoqMarkerTargetChangedError('The re-resolved target changed.');
        }
        const operations = position && !options.directCaret
          ? buildAbsoluteCursorOperations(position.cursorOffset, action)
          : [action];
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

        if (!position) throw new Error('Missing marker position.');
        assert.equal(position.expectedValue, value);
        const atoms = tokenizeEditorAtoms(value);
        const offset = options.directCaret
          ? tokenizeEditorAtoms(value.slice(0, position.textOffset)).length
          : operations.find(op => op.type === 'moveRight')?.count ?? 0;
        assert.equal(atoms.slice(0, offset).join('').length, position.textOffset);

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
            : options.sourceGroups?.[markerIndex] ?? plan.anchors[markerIndex]?.markers.join('');
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
    2500
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

test('memoQ fills nine repeated tag pairs using only Delete and F9 when each caret is located', async () => {
  const labels = Array.from({ length: 9 }, (_, index) => `label ${index + 1}`);
  const marked = (label: string) => `<span color="red">${label}</>`;
  const native = (label: string) => `<1>${label}<2>`;
  const french = labels.map(label => `Libellé 👩‍🚀 ${label}`);
  const sourceGroups = labels.flatMap(() => ['<1>', '<2>']);
  const plan = sequentialPlan(
    labels.map(marked).join(', '), labels.map(native).join(', '), french.map(marked).join(' et ')
  );
  const harness = createEditorHarness({ plan, directCaret: true, sourceGroups });
  await harness.executor.execute();
  assert.equal(harness.value(), french.map(native).join(' et '));
  assert.deepEqual(harness.inputCalls, sourceGroups.flatMap(() => [
    [{ type: 'deleteForward' }], [{ type: 'key', key: 'F9' }]
  ]));
  assert.equal(harness.waitDelays.reduce((sum, ms) => sum + ms, 0), 5700);

  sourceGroups[16] = '<9>';
  const wrong = createEditorHarness({ plan, directCaret: true, sourceGroups });
  const error = await captureExecutionError(wrong.executor);
  assert.equal(error instanceof MemoqMarkerMaterializationError && error.rollbackSucceeded, true);
  assert.equal(wrong.value(), '');
});

test('MemoqMarkerFillExecutor inserts native tags at translated line breaks', async () => {
  const plan = sequentialPlan(
    'First\r\n\r\nSecond\r\nThird',
    'First<7><7>Second<7>Third',
    'Premier\n\nDeuxième\nTroisième'
  );
  const harness = createEditorHarness({ plan });

  await harness.executor.execute();

  assert.deepEqual(harness.writes, ['Premier\uE000Deuxième\uE001Troisième']);
  assert.equal(harness.value(), 'Premier<7><7>Deuxième<7>Troisième');
  assert.deepEqual(
    harness.inputCalls.filter((operations) => operations.at(-1)?.type === 'key')
      .map((operations) => operations.at(-1)),
    [{ type: 'key', key: 'F9' }, { type: 'key', key: 'F9' }]
  );
});

test('MemoqMarkerFillExecutor materializes flattened webTrans tag pairs', async () => {
  const harness = createEditorHarness({ plan: makeFlattenedFileTagPlan() });

  await harness.executor.execute();

  assert.equal(
    harness.value(),
    'スキルのクールタイムが<1>5<2>秒短縮される。'
  );
  assert.deepEqual(
    harness.inputCalls.map((operations) => operations.at(-1)),
    [
      { type: 'deleteForward' },
      { type: 'key', key: 'F9' },
      { type: 'deleteForward' },
      { type: 'key', key: 'F9' }
    ]
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

test('memoQ stops before undoing a target changed between reads and dispatch', async () => {
  const harness = createEditorHarness({ changeBeforeInput: 'Manual translation' });
  const error = await captureExecutionError(harness.executor);
  assert.equal(error instanceof MemoqMarkerMaterializationError && !error.rollbackSucceeded, true);
  assert.equal(harness.value(), 'Manual translation');
  assert.equal(harness.undoCount(), 0);
  assert.deepEqual(harness.inputCalls, []);
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
  const harness = createEditorHarness({ driftAfterWaitMs: 2300 });
  const error = await captureExecutionError(harness.executor);

  assert.equal(
    error instanceof MemoqMarkerMaterializationError
      ? error.rollbackSucceeded
      : false,
    true
  );

  assert.equal(harness.value(), '');
});

test('buildAbsoluteCursorOperations relies on the trusted text-origin click, not Ctrl+Home', () => {
  assert.deepEqual(
    buildAbsoluteCursorOperations(7, { type: 'key', key: 'F9' }),
    [
      { type: 'moveLeft', count: 1 },
      { type: 'moveRight', count: 7 },
      { type: 'key', key: 'F9' }
    ]
  );
  assert.deepEqual(
    buildAbsoluteCursorOperations(0, { type: 'deleteForward' }),
    [{ type: 'moveLeft', count: 1 }, { type: 'deleteForward' }]
  );
});
