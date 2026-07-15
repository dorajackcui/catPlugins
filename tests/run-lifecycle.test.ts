import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackgroundRunLifecycle,
  type BackgroundRunLifecyclePort
} from '../background/run-lifecycle.ts';
import type { RuntimeStateUpdate } from '../background/storage.ts';
import { DEFAULT_FILL_OPTIONS } from '../domain/fill-options.ts';
import { DEFAULT_RUN_STATE } from '../domain/run-state.ts';
import { RUN_STOP_ERROR_MESSAGE } from '../domain/run-stop.ts';
import type { RuntimeState } from '../shared/state-types.ts';

function makeRuntimeState(
  overrides: Partial<RuntimeState> = {}
): RuntimeState {
  return {
    translationEntries: [],
    previewResult: null,
    uploadMeta: null,
    fillOptions: { ...DEFAULT_FILL_OPTIONS },
    runState: { ...DEFAULT_RUN_STATE },
    ...overrides
  };
}

function createHarness(initialState = makeRuntimeState()) {
  let state = initialState;
  const writes: RuntimeStateUpdate[] = [];
  const port: BackgroundRunLifecyclePort = {
    async readRuntimeState() {
      return state;
    },
    async writeRuntimeState(update) {
      writes.push(update);
      state = { ...state, ...update };
    },
    now: () => new Date('2026-07-15T12:34:56.000Z')
  };

  return {
    lifecycle: new BackgroundRunLifecycle(port),
    writes,
    getState: () => state
  };
}

test('BackgroundRunLifecycle starts a fill with target and option state', async () => {
  const harness = createHarness();
  const fillOptions = {
    autoStopAfterFilledCount: 4,
    validatePlaceholders: false
  };

  const runState = await harness.lifecycle.start(
    'fill',
    { id: 42, frameId: 7 },
    { fillOptions, plannedFillCount: 9 }
  );

  assert.equal(runState.kind, 'fill');
  assert.equal(runState.phase, 'running');
  assert.equal(runState.tabId, 42);
  assert.equal(runState.frameId, 7);
  assert.equal(runState.plannedFillCount, 9);
  assert.deepEqual(harness.writes[0]?.fillOptions, fillOptions);
  assert.equal(harness.getState().runState.runId, runState.runId);
});

test('BackgroundRunLifecycle isolates completion from a stale run id', async () => {
  const harness = createHarness(
    makeRuntimeState({
      runState: {
        ...DEFAULT_RUN_STATE,
        runId: 'run-current',
        kind: 'preview',
        phase: 'running',
        startedAt: '2026-07-15T00:00:00.000Z',
        scannedCount: 12
      }
    })
  );

  await harness.lifecycle.finish('run-stale', { message: 'Done.' });

  const runState = harness.getState().runState;
  assert.equal(runState.phase, 'idle');
  assert.equal(runState.message, 'Done.');
  assert.equal(runState.startedAt, null);
  assert.equal(runState.scannedCount, 0);
});

test('BackgroundRunLifecycle maps a user stop while preserving fill planning', async () => {
  const harness = createHarness(
    makeRuntimeState({
      runState: {
        ...DEFAULT_RUN_STATE,
        runId: 'run-fill',
        kind: 'fill',
        phase: 'running',
        plannedFillCount: 9,
        filledCount: 3
      }
    })
  );

  await harness.lifecycle.finishFailure(
    'run-fill',
    new Error(RUN_STOP_ERROR_MESSAGE),
    'Fill failed.',
    { plannedFillCount: 9 }
  );

  const runState = harness.getState().runState;
  assert.equal(runState.phase, 'idle');
  assert.equal(runState.message, 'Stopped.');
  assert.equal(runState.statusKind, 'default');
  assert.equal(runState.filledCount, 3);
  assert.equal(runState.plannedFillCount, 9);
});

test('BackgroundRunLifecycle marks the current run stopping at the port time', async () => {
  const harness = createHarness();
  const runningState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'export' as const,
    phase: 'running' as const,
    tabId: 81,
    frameId: 6
  };

  await harness.lifecycle.markStopping(runningState);

  const runState = harness.getState().runState;
  assert.equal(runState.phase, 'stopping');
  assert.equal(runState.runId, 'run-1');
  assert.equal(runState.tabId, 81);
  assert.equal(runState.frameId, 6);
  assert.equal(runState.statusKind, 'default');
  assert.equal(runState.lastUpdatedAt, '2026-07-15T12:34:56.000Z');
});
