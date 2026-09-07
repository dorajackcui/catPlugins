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

test('memoQ marker plan accepts paired Excel tags flattened to empty memoQ markers', () => {
  const result = createMemoqMarkerFillPlan(
    'Before<BlueBold>name</>After',
    'Before<1>name<2>After',
    'Avant<BlueBold>nom</>Après'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: 'Avant<1>nom<2>Après',
      skeletonTarget: 'Avant\uE000nom\uE001Après',
      anchors: [
        { sentinel: '\uE000', markers: ['<1>'] },
        { sentinel: '\uE001', markers: ['<2>'] }
      ]
    }
  });
});

test('memoQ marker plan maps the real webTrans span representation', () => {
  const result = createMemoqMarkerFillPlan(
    '技能冷却时间降低<span color=\\"#FF8E33\\">5</>秒。',
    '技能冷却时间降低<1>5<2>秒。',
    'スキルのクールタイムが<span color=\\"#FF8E33\\">5</>秒短縮される。'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget: 'スキルのクールタイムが<1>5<2>秒短縮される。',
      skeletonTarget: 'スキルのクールタイムが\uE0005\uE001秒短縮される。',
      anchors: [
        { sentinel: '\uE000', markers: ['<1>'] },
        { sentinel: '\uE001', markers: ['<2>'] }
      ]
    }
  });
});

test('memoQ marker plan maps the repeated span, hyperlink, and counter sequence', () => {
  const result = createMemoqMarkerFillPlan(
    '使用猛狩科技的<span color=\\"#FF8E33\\">药剂加工链</>，制造1个<hyperlink color=\\"#FF8E33\\" action=\\"13000000901\\">{2}</>({0}/{1})',
    '使用猛狩科技的<1>药剂加工链<2>，制造1个<3><4><2>(<5>/<6>)',
    'ビーストテクノロジーの<span color=\\"#FF8E33\\">薬剤加工ライン</>を使用して、<hyperlink color=\\"#FF8E33\\" action=\\"13000000901\\">{2}</>を1個製造する({0}/{1})'
  );

  assert.deepEqual(result, {
    ok: true,
    plan: {
      expectedTarget:
        'ビーストテクノロジーの<1>薬剤加工ライン<2>を使用して、<3><4><2>を1個製造する(<5>/<6>)',
      skeletonTarget:
        'ビーストテクノロジーの\uE000薬剤加工ライン\uE001を使用して、\uE002を1個製造する(\uE003/\uE004)',
      anchors: [
        { sentinel: '\uE000', markers: ['<1>'] },
        { sentinel: '\uE001', markers: ['<2>'] },
        { sentinel: '\uE002', markers: ['<3>', '<4>', '<2>'] },
        { sentinel: '\uE003', markers: ['<5>'] },
        { sentinel: '\uE004', markers: ['<6>'] }
      ]
    }
  });
});

test('memoQ marker plan rejects non-empty marker kind changes', () => {
  const result = createMemoqMarkerFillPlan(
    'Before{0}After',
    'Before{1>After',
    'Avant{0}Après'
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reason,
    'Excel markup types do not match memoQ marker types.'
  );
});
