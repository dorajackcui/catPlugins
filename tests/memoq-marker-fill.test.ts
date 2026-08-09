import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countMemoqCursorUnitsBeforeAnchor,
  createMemoqMarkerFillPlan
} from '../domain/memoq-marker-fill.ts';

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
      skeletonTarget: 'レベル\uE000到達で解放',
      anchors: [{ sentinel: '\uE000', markers: ['<1>'] }]
    }
  });
});

test('memoQ marker plan creates one anchor per native marker sequence', () => {
  const result = createMemoqMarkerFillPlan(
    '{ZoneName}{RankName}第{RankIndex}名',
    '<1><2>第<3>名',
    '{ZoneName}{RankName}第{RankIndex}位'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: '<1><2>第<3>位',
      skeletonTarget: '\uE000第\uE001位',
      anchors: [
        { sentinel: '\uE000', markers: ['<1>', '<2>'] },
        { sentinel: '\uE001', markers: ['<3>'] }
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

test('memoQ marker plan maps paired Excel tags to native memoQ markers', () => {
  const result = createMemoqMarkerFillPlan(
    '吾王只能<BlueBold>仰视</>着您。',
    '吾王只能{1>仰视<2}着您。',
    'Mon Roi doit <BlueBold>lever les yeux vers vous</>°!'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: 'Mon Roi doit {1>lever les yeux vers vous<2}°!',
      skeletonTarget: 'Mon Roi doit \uE000lever les yeux vers vous\uE001°!',
      anchors: [
        { sentinel: '\uE000', markers: ['{1>'] },
        { sentinel: '\uE001', markers: ['<2}'] }
      ]
    }
  });
});

test('memoQ marker plan avoids private-use characters already present in text', () => {
  const result = createMemoqMarkerFillPlan(
    'Before{0}',
    'Before<1>',
    `Avant\uE000{0}`
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.plan.anchors[0]?.sentinel : '', '\uE001');
});

test('memoQ cursor offsets use immutable skeleton graphemes without parsing literal marker text', () => {
  assert.equal(
    countMemoqCursorUnitsBeforeAnchor('A👨‍👩‍👧‍👦<1>\uE000', '\uE000'),
    5
  );
  assert.equal(
    countMemoqCursorUnitsBeforeAnchor('\uE000A\uE001', '\uE001'),
    2
  );
  assert.equal(countMemoqCursorUnitsBeforeAnchor('\uE000x\uE000', '\uE000'), null);
  assert.equal(countMemoqCursorUnitsBeforeAnchor('text', '\uE000'), null);
});

test('memoQ marker plan rejects mismatched paired marker kinds', () => {
  const result = createMemoqMarkerFillPlan(
    'Before<BlueBold>name</>After',
    'Before<1>name<2>After',
    'Avant<BlueBold>nom</>Après'
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'Excel markup types do not match memoQ marker types.'
  );
});
