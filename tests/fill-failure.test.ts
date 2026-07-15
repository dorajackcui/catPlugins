import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeFillStopReason,
  shouldStopAfterFillFailure
} from '../fill-failure.ts';

test('Phrase fill failures stop the run with source context', () => {
  assert.equal(shouldStopAfterFillFailure('phrase'), true);
  assert.equal(
    describeFillStopReason(
      {
        platform: 'phrase',
        domId: 'segment-position-14',
        sourceRaw: '布拉德米勒<color=#fa7000>背打转身后</color>。',
      },
      {
        reason: 'Unable to confirm target update after writing.'
      }
    ),
    'Stopped at Phrase segment segment-position-14: Unable to confirm target update after writing. Source="布拉德米勒<color=#fa7000>背打转身后</color>。"'
  );
});

test('non Phrase/memoQ fill failures can continue scanning', () => {
  assert.equal(shouldStopAfterFillFailure('gientrans'), false);
  assert.equal(shouldStopAfterFillFailure('generic'), false);
});
