import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmMemoqTargetText } from '../platforms/memoq/fill-confirmation.ts';

test('confirmMemoqTargetText re-resolves the row and succeeds on the observed attempt', async () => {
  const scannedTarget = {} as HTMLElement;
  const currentTarget = {} as HTMLElement;
  const waits: number[] = [];
  let resolveCount = 0;

  const result = await confirmMemoqTargetText({
    target: scannedTarget,
    rowNumber: '42',
    value: 'Translation',
    resolveCurrentTargetByRowNumber: (rowNumber) => {
      assert.equal(rowNumber, '42');
      resolveCount += 1;
      return currentTarget;
    },
    readTargetText: (target) => {
      assert.equal(target, currentTarget);
      return resolveCount === 3 ? 'Translation' : '';
    }
  }, async (delayMs) => {
    waits.push(delayMs);
  });

  assert.deepEqual(result, {
    ok: true,
    attempts: 3,
    targetAfter: 'Translation'
  });
  assert.deepEqual(waits, [150, 150]);
});

test('confirmMemoqTargetText reports ROW_NOT_FOUND after fourteen unresolved attempts', async () => {
  const waits: number[] = [];
  let resolveCount = 0;
  let readCount = 0;

  const result = await confirmMemoqTargetText({
    target: {} as HTMLElement,
    rowNumber: '42',
    value: 'Translation',
    resolveCurrentTargetByRowNumber: () => {
      resolveCount += 1;
      return null;
    },
    readTargetText: () => {
      readCount += 1;
      return '';
    }
  }, async (delayMs) => {
    waits.push(delayMs);
  });

  assert.deepEqual(result, {
    ok: false,
    attempts: 14,
    targetAfter: '',
    failureCode: 'ROW_NOT_FOUND'
  });
  assert.equal(resolveCount, 14);
  assert.equal(readCount, 0);
  assert.deepEqual(waits, Array.from({ length: 13 }, () => 150));
});

test('confirmMemoqTargetText reports a timeout after resolving but never observing the write', async () => {
  const target = {} as HTMLElement;
  const waits: number[] = [];

  const result = await confirmMemoqTargetText({
    target,
    rowNumber: '42',
    value: 'Translation',
    resolveCurrentTargetByRowNumber: () => target,
    readTargetText: () => 'Still empty'
  }, async (delayMs) => {
    waits.push(delayMs);
  });

  assert.deepEqual(result, {
    ok: false,
    attempts: 14,
    targetAfter: 'Still empty',
    failureCode: undefined
  });
  assert.deepEqual(waits, Array.from({ length: 13 }, () => 150));
});

test('confirmMemoqTargetText uses the scanned target when no row number exists', async () => {
  const target = {} as HTMLElement;
  let resolves = 0;

  const result = await confirmMemoqTargetText({
    target,
    rowNumber: '',
    value: 'Translation',
    resolveCurrentTargetByRowNumber: () => {
      resolves += 1;
      return null;
    },
    readTargetText: (currentTarget) => {
      assert.equal(currentTarget, target);
      return 'Translation';
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(resolves, 0);
});
