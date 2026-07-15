import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRunFailure,
  RUN_STOP_ERROR_MESSAGE,
  RUN_STOPPED_MESSAGE
} from '../domain/run-stop.ts';

test('describeRunFailure maps explicit user stops to a default status', () => {
  assert.deepEqual(
    describeRunFailure(new Error(RUN_STOP_ERROR_MESSAGE), 'Fill failed.'),
    { message: RUN_STOPPED_MESSAGE, statusKind: 'default' }
  );
});

test('describeRunFailure preserves errors and uses fallbacks for unknown values', () => {
  assert.deepEqual(
    describeRunFailure(new Error('Editor failed.'), 'Fill failed.'),
    { message: 'Editor failed.', statusKind: 'error' }
  );
  assert.deepEqual(describeRunFailure({}, 'Fill failed.'), {
    message: 'Fill failed.',
    statusKind: 'error'
  });
});
