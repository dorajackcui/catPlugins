import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoqMarkerFillPlan } from '../domain/memoq-marker-fill.ts';

test('memoQ marker plan maps one Excel placeholder to one native marker', () => {
  const result = createMemoqMarkerFillPlan(
    '到达等级{0}后解锁',
    '到达等级<1>后解锁',
    'レベル{0}到達で解放'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: 'レベル<1>到達で解放',
      markerCount: 1,
      markerSequenceCount: 1,
      operations: [
        { type: 'text', text: 'レベル' },
        { type: 'markerSequence', markers: ['<1>'] },
        { type: 'text', text: '到達で解放' }
      ]
    }
  });
});

test('memoQ marker plan preserves adjacent marker sequences', () => {
  const result = createMemoqMarkerFillPlan(
    '{ZoneName}{RankName}第{RankIndex}名',
    '<1><2>第<3>名',
    '{ZoneName}{RankName}第{RankIndex}位'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: '<1><2>第<3>位',
      markerCount: 3,
      markerSequenceCount: 2,
      operations: [
        { type: 'markerSequence', markers: ['<1>', '<2>'] },
        { type: 'text', text: '第' },
        { type: 'markerSequence', markers: ['<3>'] },
        { type: 'text', text: '位' }
      ]
    }
  });
});

test('memoQ marker plan rejects reordered or regrouped target placeholders', () => {
  const reordered = createMemoqMarkerFillPlan(
    '{ZoneName}{RankName}第{RankIndex}名',
    '<1><2>第<3>名',
    '{RankName}{ZoneName}第{RankIndex}位'
  );
  const regrouped = createMemoqMarkerFillPlan(
    '{ZoneName}{RankName}第{RankIndex}名',
    '<1><2>第<3>名',
    '{ZoneName}の{RankName}第{RankIndex}位'
  );

  assert.equal(reordered.ok, false);
  assert.equal(regrouped.ok, false);
  assert.equal(
    reordered.ok ? '' : reordered.reason,
    'Target placeholders must preserve the source placeholder order.'
  );
  assert.equal(
    regrouped.ok ? '' : regrouped.reason,
    'Target placeholder grouping does not match memoQ marker sequences.'
  );
});

test('memoQ marker plan keeps paired markers outside the experimental scope', () => {
  const result = createMemoqMarkerFillPlan(
    'Before{name}After',
    'Before{1>After',
    'Avant{name}Après'
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'Paired memoQ markers are not supported by the experimental path yet.'
  );
});
