import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPauseBulkFill, shouldPauseBulkFillForPlatform } from '../fill-throttle.ts';

test('bulk pause stays disabled for tasks with 300 rows or fewer', () => {
  assert.equal(shouldPauseBulkFill(300, 200), false);
  assert.equal(shouldPauseBulkFill(120, 200), false);
});

test('bulk pause fires every 200 successful fills for larger tasks', () => {
  assert.equal(shouldPauseBulkFill(301, 199), false);
  assert.equal(shouldPauseBulkFill(301, 200), true);
  assert.equal(shouldPauseBulkFill(301, 201), false);
  assert.equal(shouldPauseBulkFill(520, 400), true);
});

test('Phrase fills do not use the hidden 200-row cooldown', () => {
  assert.equal(shouldPauseBulkFillForPlatform('phrase', 500, 200), false);
  assert.equal(shouldPauseBulkFillForPlatform('memoq', 500, 200), true);
});
