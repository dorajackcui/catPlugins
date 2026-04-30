import assert from 'node:assert/strict';
import test from 'node:test';

import { formatFillCompletionMessage } from '../fill-result.ts';

test('formatFillCompletionMessage handles auto-stop and failure summaries', () => {
  assert.equal(
    formatFillCompletionMessage({
      filledCount: 8,
      failedCount: 2,
      stoppedByAutoStop: true,
      autoStopAfterFilledCount: 8
    }),
    'Filled 8 segment(s), failed 2 segment(s), and auto-stopped at 8.'
  );

  assert.equal(
    formatFillCompletionMessage({
      filledCount: 3,
      failedCount: 1,
      stoppedByAutoStop: false,
      autoStopAfterFilledCount: null
    }),
    'Filled 3 segment(s), failed 1 segment(s).'
  );
});
