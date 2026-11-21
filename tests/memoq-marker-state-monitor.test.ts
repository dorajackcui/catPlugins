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

test('a transient fast edit restarts all six exact reads at the normal settling interval', async () => {
  const expected = 'A<1>B';
  const observations = [expected, expected, null, 'A B', ...Array(6).fill(expected)];
  const waits: number[] = [];
  let reads = 0;
  const monitor = new MemoqMarkerStateMonitor({
    readCurrentValue: () => observations[reads++] ?? null,
    wait: async ms => { waits.push(ms); }
  });
  await monitor.waitForEdit('AB', expected, 'inserting F9');
  assert.equal(reads, observations.length);
  assert.deepEqual(waits, [20, 20, ...Array(6).fill(120)]);
});

test('an edit rendered two frames late still receives six quick exact reads', async () => {
  const observations = ['AB', 'AB', ...Array(6).fill('A<1>B')];
  const waits: number[] = [];
  let reads = 0;
  const monitor = new MemoqMarkerStateMonitor({
    readCurrentValue: () => observations[reads++] ?? null,
    wait: async ms => { waits.push(ms); }
  });
  await monitor.waitForEdit('AB', 'A<1>B', 'inserting F9');
  assert.equal(reads, observations.length);
  assert.deepEqual(waits, Array(7).fill(20));
});
