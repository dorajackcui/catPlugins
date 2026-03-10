import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasRepeatedSyntheticSignature,
  isRecentSyntheticDuplicate
} from '../scan-dedupe.ts';

test('hasRepeatedSyntheticSignature only flags non-empty repeated signatures', () => {
  assert.equal(hasRepeatedSyntheticSignature('', 'hello=>'), false);
  assert.equal(hasRepeatedSyntheticSignature('hello=>', 'hello=>'), true);
  assert.equal(hasRepeatedSyntheticSignature('hello=>', 'world=>'), false);
});

test('isRecentSyntheticDuplicate only skips nearby passes with the same fingerprint', () => {
  assert.equal(
    isRecentSyntheticDuplicate(undefined, 'Hello::', 1),
    false
  );
  assert.equal(
    isRecentSyntheticDuplicate({ fingerprint: 'Hello::', pass: 1 }, 'Hello::', 2),
    true
  );
  assert.equal(
    isRecentSyntheticDuplicate({ fingerprint: 'Hello::', pass: 1 }, 'Hello::', 4),
    false
  );
  assert.equal(
    isRecentSyntheticDuplicate({ fingerprint: 'Hello::', pass: 1 }, 'World::', 2),
    false
  );
});
