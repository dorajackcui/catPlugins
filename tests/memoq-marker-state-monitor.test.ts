import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoqMarkerStateMonitor } from '../platforms/memoq/marker-state-monitor.ts';

test('memoQ stable state requires consecutive exact reads after missing or changed DOM', async () => {
  const observations = ['A  <1>', 'A  <1>', null, 'A  <1>', 'A <1>', ...Array(6).fill('A  <1>')];
  let reads = 0;
  const monitor = new MemoqMarkerStateMonitor({
    readCurrentValue: () => observations[reads++] ?? null,
    wait: async () => undefined
  });

  await monitor.waitForStableValue('A  <1>', 'writing');

  assert.equal(reads, observations.length);
});

test('memoQ exact hold catches drift on its final read', async () => {
  let elapsed = 0;
  let failure = '';
  const monitor = new MemoqMarkerStateMonitor({
    readCurrentValue: () => elapsed < 1500 ? 'A<1>' : 'A<2>',
    wait: async (ms) => { elapsed += ms; }
  });
  try {
    await monitor.waitForExactHold('A<1>', 'holding');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  assert.equal(failure, 'holding changed at the end of the hold window.');
});
