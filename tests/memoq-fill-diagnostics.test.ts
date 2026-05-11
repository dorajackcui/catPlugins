import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeMemoqFillDiagnostic,
  truncateMemoqDiagnosticValue
} from '../memoq-fill-diagnostics.ts';
import type { MemoqFillDiagnostic } from '../types.ts';

test('describeMemoqFillDiagnostic formats a stable stop reason', () => {
  const diagnostic: MemoqFillDiagnostic = {
    outcome: 'failure',
    failureCode: 'SOURCE_MISMATCH',
    runId: 'run-1',
    sequence: 3,
    scanPass: 7,
    scrollTop: 420,
    scrollMode: 'native',
    domId: '15',
    rowNumber: '15',
    locatingMethod: 'rowNumber',
    segmentSource: 'League Sponsor',
    sourceBefore: 'League Sponsor Copy',
    targetBefore: '',
    expectedTranslation: 'Sponsor de ligue',
    activation: {
      attempted: false,
      ok: false
    },
    inputMethod: 'chrome-debugger',
    targetAfter: '',
    confirmation: {
      ok: false,
      attempts: 0
    },
    nearbyRows: [
      {
        rowNumber: '14',
        source: 'Previous',
        target: ''
      },
      {
        rowNumber: '15',
        source: 'League Sponsor Copy',
        target: ''
      }
    ]
  };

  assert.equal(
    describeMemoqFillDiagnostic(diagnostic),
    'Stopped at memoQ row 15: Source changed before writing. Source="League Sponsor Copy"'
  );
});

test('truncateMemoqDiagnosticValue keeps messages readable', () => {
  assert.equal(truncateMemoqDiagnosticValue('Short text'), 'Short text');
  assert.equal(
    truncateMemoqDiagnosticValue('1234567890', 8),
    '12345...'
  );
});
