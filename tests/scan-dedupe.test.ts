import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasRepeatedSyntheticSignature,
  isRecentSyntheticDuplicate,
  shouldRescanAfterSegmentFill,
  shouldStopScanBeforeNextScroll
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

test('memoQ fills rescan before using the rest of a visible-row snapshot', () => {
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'memoq' }, { filled: true }),
    true
  );
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'phrase' }, { filled: true }),
    false
  );
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'memoq' }, { filled: false }),
    false
  );
});

test('native scanning stops as soon as the bottom is reached', () => {
  assert.equal(
    shouldStopScanBeforeNextScroll({
      scrollMode: 'native',
      isAtBottom: true,
      noNewSegmentsPasses: 0,
      repeatedSyntheticSignaturePasses: 0
    }),
    true
  );
});

test('native scanning continues before the bottom is reached', () => {
  assert.equal(
    shouldStopScanBeforeNextScroll({
      scrollMode: 'native',
      isAtBottom: false,
      noNewSegmentsPasses: 0,
      repeatedSyntheticSignaturePasses: 0
    }),
    false
  );
});

test('synthetic scanning still stops on repeated snapshots', () => {
  assert.equal(
    shouldStopScanBeforeNextScroll({
      scrollMode: 'synthetic',
      isAtBottom: false,
      noNewSegmentsPasses: 0,
      repeatedSyntheticSignaturePasses: 2
    }),
    true
  );
});
