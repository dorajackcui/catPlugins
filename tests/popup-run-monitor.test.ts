import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PopupRunMonitor,
  type PopupRunMonitorView
} from '../popup/run-monitor.ts';
import { DEFAULT_RUN_STATE } from '../domain/run-state.ts';
import type { StatusKind } from '../shared/state-types.ts';

function createHarness(refreshState: () => Promise<void> = async () => {}) {
  const busyValues: boolean[] = [];
  const stoppingValues: boolean[] = [];
  const statuses: Array<{ message: string; kind: StatusKind }> = [];
  const intervalCalls: Array<{ timerId: number; delayMs: number }> = [];
  const intervalCallbacks = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  let nextTimerId = 1;
  const view: PopupRunMonitorView = {
    setBusy(value) {
      busyValues.push(value);
    },
    setStopping(value) {
      stoppingValues.push(value);
    },
    renderStatus(message, kind = 'default') {
      statuses.push({ message, kind });
    }
  };
  const monitor = new PopupRunMonitor({
    view,
    refreshState,
    setInterval(callback, delayMs) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      intervalCalls.push({ timerId, delayMs });
      intervalCallbacks.set(timerId, callback);
      return timerId;
    },
    clearInterval(timerId) {
      clearedTimers.push(timerId);
      intervalCallbacks.delete(timerId);
    }
  });

  return {
    monitor,
    busyValues,
    stoppingValues,
    statuses,
    intervalCalls,
    intervalCallbacks,
    clearedTimers
  };
}

test('PopupRunMonitor reuses one timer while a run is active and clears it when idle', () => {
  const harness = createHarness();
  const activeRunState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'fill' as const,
    phase: 'running' as const,
    plannedFillCount: 5,
    filledCount: 2
  };

  harness.monitor.renderRunState(activeRunState);
  harness.monitor.renderRunState(activeRunState);
  harness.monitor.renderRunState(DEFAULT_RUN_STATE);

  assert.deepEqual(harness.busyValues, [true, true, false]);
  assert.deepEqual(harness.stoppingValues, [false, false, false]);
  assert.deepEqual(harness.intervalCalls, [{ timerId: 1, delayMs: 1000 }]);
  assert.deepEqual(harness.clearedTimers, [1]);
  assert.equal(harness.statuses[0]?.message, 'Filled 2 / 5 segment(s); scanned 0.');
  assert.equal(harness.statuses.at(-1)?.message, 'Ready.');
});

test('PopupRunMonitor only begins Stop for one busy non-stopping run', () => {
  const harness = createHarness();

  assert.equal(harness.monitor.tryBeginStop(), false);
  harness.monitor.beginRun('Scanning...');
  assert.equal(harness.monitor.tryBeginStop(), true);
  assert.equal(harness.monitor.tryBeginStop(), false);
  harness.monitor.failStop(new Error('Stop request failed.'));
  assert.equal(harness.monitor.tryBeginStop(), true);
  harness.monitor.finishRun();
  assert.equal(harness.monitor.tryBeginStop(), false);

  assert.deepEqual(harness.busyValues, [true, false]);
  assert.deepEqual(harness.stoppingValues, [false, true, false, true, false]);
  assert.equal(
    harness.statuses.some(
      ({ message, kind }) =>
        message === 'Stop request failed.' && kind === 'error'
    ),
    true
  );
});

test('PopupRunMonitor clears polling and reports refresh failures', async () => {
  let rejectRefresh: (error: Error) => void = () => {};
  const refreshPromise = new Promise<void>((_resolve, reject) => {
    rejectRefresh = reject;
  });
  const harness = createHarness(() => refreshPromise);
  harness.monitor.beginRun('Filling...');
  const timerCallback = harness.intervalCallbacks.get(1);

  timerCallback?.();
  rejectRefresh(new Error('Background unavailable.'));
  await refreshPromise.catch(() => undefined);
  await Promise.resolve();

  assert.deepEqual(harness.clearedTimers, [1]);
  assert.equal(harness.intervalCallbacks.size, 0);
  assert.equal(
    harness.statuses.some(
      ({ message, kind }) =>
        message === 'Background unavailable.' && kind === 'error'
    ),
    true
  );
});
