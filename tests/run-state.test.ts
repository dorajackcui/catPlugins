import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFinishedRunState,
  createRunningRunState,
  DEFAULT_RUN_STATE,
  describeRunState,
  isRunActive,
  mergeRunProgress,
  normalizeRunState
} from '../domain/run-state.ts';

test('normalizeRunState falls back to defaults', () => {
  assert.deepEqual(normalizeRunState(undefined), DEFAULT_RUN_STATE);
});

test('createRunningRunState initializes a deterministic running task', () => {
  assert.deepEqual(
    createRunningRunState(
      'fill',
      { id: 42, frameId: 7 },
      {
        plannedFillCount: 12.8,
        runId: 'run-1',
        startedAt: '2026-07-15T10:00:00.000Z'
      }
    ),
    {
      runId: 'run-1',
      kind: 'fill',
      phase: 'running',
      statusKind: 'default',
      startedAt: '2026-07-15T10:00:00.000Z',
      lastUpdatedAt: '2026-07-15T10:00:00.000Z',
      tabId: 42,
      frameId: 7,
      plannedFillCount: 12,
      scannedCount: 0,
      filledCount: 0,
      message: ''
    }
  );
});

test('createFinishedRunState clears task identity and preserves progress by default', () => {
  const runningState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'fill' as const,
    phase: 'running' as const,
    startedAt: '2026-07-15T10:00:00.000Z',
    lastUpdatedAt: '2026-07-15T10:01:00.000Z',
    tabId: 42,
    frameId: 7,
    plannedFillCount: 12,
    scannedCount: 9,
    filledCount: 5,
    message: 'Working...'
  };

  assert.deepEqual(
    createFinishedRunState(runningState, {
      message: 'Stopped.',
      statusKind: 'error',
      finishedAt: '2026-07-15T10:02:00.000Z'
    }),
    {
      ...DEFAULT_RUN_STATE,
      statusKind: 'error',
      startedAt: '2026-07-15T10:00:00.000Z',
      lastUpdatedAt: '2026-07-15T10:02:00.000Z',
      plannedFillCount: 12,
      scannedCount: 9,
      filledCount: 5,
      message: 'Stopped.'
    }
  );
});

test('createFinishedRunState applies explicit final progress overrides', () => {
  const runningState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'preview' as const,
    phase: 'running' as const,
    plannedFillCount: 12,
    scannedCount: 9,
    filledCount: 5
  };

  const finishedState = createFinishedRunState(runningState, {
    message: 'Preview ready.',
    scannedCount: 15.9,
    filledCount: 8.7,
    plannedFillCount: null,
    finishedAt: '2026-07-15T10:02:00.000Z'
  });

  assert.equal(finishedState.scannedCount, 15);
  assert.equal(finishedState.filledCount, 8);
  assert.equal(finishedState.plannedFillCount, null);
});

test('mergeRunProgress keeps counters monotonic and normalizes planned work', () => {
  const runningState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'fill' as const,
    phase: 'running' as const,
    lastUpdatedAt: '2026-07-15T10:00:00.000Z',
    plannedFillCount: 12,
    scannedCount: 10,
    filledCount: 4,
    message: 'Working...'
  };

  const mergedState = mergeRunProgress(
    runningState,
    {
      runId: 'run-1',
      scannedCount: 8,
      filledCount: 6.9,
      plannedFillCount: 20.8,
      message: '   '
    },
    '2026-07-15T10:03:00.000Z'
  );

  assert.equal(mergedState.scannedCount, 10);
  assert.equal(mergedState.filledCount, 6);
  assert.equal(mergedState.plannedFillCount, 20);
  assert.equal(mergedState.message, 'Working...');
  assert.equal(mergedState.lastUpdatedAt, '2026-07-15T10:03:00.000Z');
});

test('mergeRunProgress never changes a stopping task back to running', () => {
  const stoppingState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'fill' as const,
    phase: 'stopping' as const
  };

  const mergedState = mergeRunProgress(
    stoppingState,
    {
      runId: 'run-1',
      phase: 'running',
      scannedCount: 12,
      message: 'Almost done.'
    },
    '2026-07-15T10:03:00.000Z'
  );

  assert.equal(mergedState.phase, 'stopping');
  assert.equal(mergedState.scannedCount, 12);
  assert.equal(mergedState.message, 'Almost done.');
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

test('describeRunState summarizes export progress', () => {
  assert.equal(
    describeRunState({
      ...DEFAULT_RUN_STATE,
      phase: 'running',
      kind: 'export',
      scannedCount: 37
    }),
    'Export running. Scanned 37 segment(s)...'
  );
});
