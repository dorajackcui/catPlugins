import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeFillResult,
  includeEditorTagErrors,
  describeFillStopReason,
  shouldStopAfterFillFailure
} from '../domain/fill-failure.ts';
import { summarizePreview } from '../domain/matcher.ts';

test('the completion status names a rejected memoQ row and its foreign tag', () => {
  const result = { filledCount: 3, filledDomIds: [], autoStopAfterFilledCount: null, stoppedByAutoStop: false,
    preview: summarizePreview([{ platform: 'memoq', domId: '910', rowNumber: '910', status: 'placeholderError',
      reason: 'Target tag <99> is absent from this source row.', sourceRaw: 'A<1>', sourceNormalized: 'A<1>',
      occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [] }]) };
  assert.equal(includeEditorTagErrors(describeFillResult(result), result.preview),
    'Filled 3 segment(s). Skipped 1 row with tag errors. Row 910. Target tag <99> is absent from this source row.');
});

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
