import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/dom.ts';
import { MemoqFillDiagnosticBuilder } from '../platforms/memoq/fill-diagnostic-builder.ts';

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

test('MemoqFillDiagnosticBuilder keeps execution context and active element details', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: {
      tagName: 'TEXTAREA',
      id: 'memoq-editor',
      className: 'target active'
    }
  } as unknown as Document;
  const nearbyRows = [{ rowNumber: '42', source: 'Source text', target: '' }];
  const builder = new MemoqFillDiagnosticBuilder({
    profileId: 'modern-editor',
    collectNearbyRows: (rowNumber) => {
      assert.equal(rowNumber, '42');
      return nearbyRows;
    },
    runId: 'run-123',
    sequence: 7,
    scanPass: 3,
    scrollTop: 480,
    scrollMode: 'synthetic'
  });

  try {
    const diagnostic = builder.createFailure({
      segment: createSegment(),
      value: 'Translation',
      failureCode: 'SOURCE_MISMATCH',
      sourceBefore: 'Changed source',
      targetBefore: '',
      targetAfter: '',
      confirmationAttempts: 0,
      activationAttempted: false,
      activationOk: false
    });

    assert.equal(diagnostic.outcome, 'failure');
    assert.equal(diagnostic.failureCode, 'SOURCE_MISMATCH');
    assert.equal(diagnostic.runId, 'run-123');
    assert.equal(diagnostic.sequence, 7);
    assert.equal(diagnostic.scanPass, 3);
    assert.equal(diagnostic.scrollTop, 480);
    assert.equal(diagnostic.scrollMode, 'synthetic');
    assert.equal(diagnostic.profileId, 'modern-editor');
    assert.equal(diagnostic.locatingMethod, 'rowNumber');
    assert.equal(diagnostic.activation.activeElement, 'textarea#memoq-editor.target.active');
    assert.deepEqual(diagnostic.nearbyRows, nearbyRows);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('MemoqFillDiagnosticBuilder preserves success defaults without a row number', () => {
  const builder = new MemoqFillDiagnosticBuilder({
    profileId: 'legacy-webtrans',
    collectNearbyRows: () => []
  });
  const diagnostic = builder.createSuccess({
    segment: createSegment({ rowNumber: undefined }),
    value: 'Translation',
    sourceBefore: 'Source text',
    targetBefore: '',
    targetAfter: 'Translation',
    confirmationAttempts: 1,
    activationAttempted: true,
    activationOk: true
  });

  assert.equal(diagnostic.outcome, 'success');
  assert.equal(diagnostic.runId, '');
  assert.equal(diagnostic.sequence, 0);
  assert.equal(diagnostic.scanPass, 0);
  assert.equal(diagnostic.scrollTop, 0);
  assert.equal(diagnostic.scrollMode, 'native');
  assert.equal(diagnostic.locatingMethod, 'none');
  assert.equal(diagnostic.confirmation.ok, true);
  assert.equal(diagnostic.confirmation.attempts, 1);
});
