import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content-script-dom.ts';
import type { MemoqDomProfile, MemoqProfileCells } from '../memoq-dom-profile.ts';
import { MemoqFillTransaction } from '../memoq-fill-transaction.ts';
import type { MemoqVisibleRowSnapshot } from '../types.ts';

function createSegment(overrides: Partial<RuntimeSegment> = {}): RuntimeSegment {
  return {
    domId: '42',
    rowNumber: '42',
    sourceRaw: 'Source text',
    sourceNormalized: 'Source text',
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform: 'memoq',
    ...overrides
  };
}

function createProfile(target: HTMLElement | null): MemoqDomProfile {
  return {
    id: 'modern-editor',
    matches: () => true,
    findVisibleRows: () => [],
    findCells: (): MemoqProfileCells | null => null,
    readRowNumber: () => undefined,
    findScrollRoot: () => null,
    findCurrentTargetByRowNumber: () => target,
    getContentRoot: (cell) => cell,
    getWriteTarget: (targetCell) => targetCell,
    createSyntheticScrollTarget: () => null
  };
}

function installImmediateTimer(): () => void {
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  return () => {
    globalThis.window = previousWindow;
  };
}

function createTransaction({
  target = {} as HTMLElement,
  source = 'Source text',
  targetText = '',
  rows = [{ rowNumber: '42', source: 'Source text', target: targetText }],
  writeTrustedText = async () => undefined
}: {
  target?: HTMLElement | null;
  source?: string;
  targetText?: string;
  rows?: MemoqVisibleRowSnapshot[];
  writeTrustedText?: (target: HTMLElement, value: string) => Promise<void>;
} = {}): MemoqFillTransaction {
  return new MemoqFillTransaction({
    profile: createProfile(target),
    readTargetText: () => targetText,
    readSourceText: () => source,
    collectNearbyRows: () => rows,
    writeTrustedText
  });
}

test('MemoqFillTransaction refuses ROW_NOT_FOUND and does not write', async () => {
  let writes = 0;
  const transaction = createTransaction({
    target: null,
    writeTrustedText: async () => {
      writes += 1;
    }
  });

  const outcome = await transaction.fillSegment(createSegment(), 'Translation');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'ROW_NOT_FOUND');
  assert.equal(outcome.diagnostic?.locatingMethod, 'rowNumber');
  assert.equal(outcome.diagnostic?.profileId, 'modern-editor');
  assert.equal(writes, 0);
});

test('MemoqFillTransaction refuses SOURCE_MISMATCH and does not write', async () => {
  let writes = 0;
  const transaction = createTransaction({
    source: 'Different source',
    writeTrustedText: async () => {
      writes += 1;
    }
  });

  const outcome = await transaction.fillSegment(createSegment(), 'Translation');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'SOURCE_MISMATCH');
  assert.equal(outcome.diagnostic?.sourceBefore, 'Different source');
  assert.equal(writes, 0);
});

test('MemoqFillTransaction refuses TARGET_NOT_EMPTY and does not write', async () => {
  let writes = 0;
  const transaction = createTransaction({
    targetText: 'Existing translation',
    writeTrustedText: async () => {
      writes += 1;
    }
  });

  const outcome = await transaction.fillSegment(createSegment(), 'Translation');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'TARGET_NOT_EMPTY');
  assert.equal(outcome.diagnostic?.targetBefore, 'Existing translation');
  assert.equal(writes, 0);
});

test('MemoqFillTransaction writes once and confirms same-row target text', async () => {
  const restoreTimer = installImmediateTimer();
  const target = {} as HTMLElement;
  let targetText = '';
  const writes: Array<{ target: HTMLElement; value: string }> = [];
  const transaction = new MemoqFillTransaction({
    profile: createProfile(target),
    readTargetText: () => targetText,
    readSourceText: () => 'Source text',
    collectNearbyRows: () => [{ rowNumber: '42', source: 'Source text', target: targetText }],
    writeTrustedText: async (writeTarget, value) => {
      writes.push({ target: writeTarget, value });
      targetText = value;
    }
  });

  try {
    const outcome = await transaction.fillSegment(createSegment(), 'Translated text');

    assert.equal(outcome.filled, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { target, value: 'Translated text' });
    assert.equal(outcome.diagnostic?.outcome, 'success');
    assert.equal(outcome.diagnostic?.profileId, 'modern-editor');
    assert.equal(outcome.diagnostic?.confirmation.ok, true);
    assert.equal(outcome.diagnostic?.targetAfter, 'Translated text');
  } finally {
    restoreTimer();
  }
});

test('MemoqFillTransaction reports INPUT_FAILED when trusted writing throws', async () => {
  let writes = 0;
  const transaction = createTransaction({
    writeTrustedText: async () => {
      writes += 1;
      throw new Error('debugger detached');
    }
  });

  const outcome = await transaction.fillSegment(createSegment(), 'Translation');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'INPUT_FAILED');
  assert.equal(outcome.diagnostic?.activation.error, 'debugger detached');
  assert.equal(writes, 1);
});
