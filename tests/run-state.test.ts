import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RUN_STATE, describeRunState, isRunActive, normalizeRunState } from '../run-state.ts';

test('normalizeRunState falls back to defaults', () => {
  assert.deepEqual(normalizeRunState(undefined), DEFAULT_RUN_STATE);
});

test('isRunActive only reports true for running phases', () => {
  assert.equal(isRunActive(DEFAULT_RUN_STATE), false);
  assert.equal(isRunActive({ ...DEFAULT_RUN_STATE, phase: 'running', kind: 'fill' }), true);
  assert.equal(isRunActive({ ...DEFAULT_RUN_STATE, phase: 'stopping', kind: 'preview' }), true);
});

test('describeRunState summarizes fill progress', () => {
  assert.equal(
    describeRunState({
      ...DEFAULT_RUN_STATE,
      phase: 'running',
      kind: 'fill',
      plannedFillCount: 420,
      scannedCount: 180,
      filledCount: 95
    }),
    'Filled 95 / 420 segment(s); scanned 180.'
  );
});
