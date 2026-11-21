import assert from 'node:assert/strict';
import test from 'node:test';

import { mapMemoqTarget, needsMemoqOriginalTags } from '../domain/memoq-marker-mapping.ts';
import { createMemoqMarkerFillPlan } from '../domain/memoq-marker-fill.ts';

test('webTrans maps each target occurrence to a chip from this row in either workbook notation', () => {
  const native = 'A<1>B<2>C<3>.';
  const raw = 'A<game:new-effect code="x"/>B{quest-name}C<custom_npc/>.';
  const markers = ['<1>', '<2>', '<3>'];
  for (const [source, tags] of [[native, markers], [raw, ['<game:new-effect code="x"/>', '{quest-name}', '<custom_npc/>']]] as const) {
    const [one, two, three] = tags;
    for (const [target, expected] of [
      [one + 'mot' + two + two + ' fin' + one, '<1>mot<2><2> fin<1>'],
      [three + two + one, '<3><2><1>'], [three, '<3>'], ['aucun', 'aucun'],
      [one.repeat(6), '<1>'.repeat(6)]
    ]) {
      const result = createMemoqMarkerFillPlan(source, native, target, undefined, markers);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.plan.expectedTarget, expected);
    }
    for (const bad of ['<4>', '{1>', '{missing}', '<custom_npc variant="new"/>']) {
      const result = mapMemoqTarget(source, native, one + bad, undefined, markers);
      assert.equal(result.ok, false);
    }
  }
  assert.equal(mapMemoqTarget(native, native, '<3>', undefined, ['<1>', '<2>']).ok, false);
});

test('webTrans learns unfamiliar file tag delimiters from the protected source gaps', () => {
  const raw = 'Find [[unit:ø]] by ⟦new.item⟧ then [[unit:ø]].';
  const native = 'Find <1> by <2> then <1>.';
  const ids = ['<1>', '<2>', '<1>'];
  const mapped = createMemoqMarkerFillPlan(raw, native, '⟦new.item⟧[[unit:ø]][[unit:ø]]', undefined, ids);
  assert.equal(mapped.ok && mapped.plan.expectedTarget, '<2><1><1>');
  for (const target of ['[[foreign]]', '⟦new.variant⟧', '<99>', '<other/>']) {
    assert.equal(mapMemoqTarget(raw, native, target, undefined, ids).ok, false);
  }
  assert.equal(mapMemoqTarget('Find X by Y then X.', native, 'X', undefined, ids).ok, false);
  assert.equal(mapMemoqTarget('[[a]]%q%', '<1><2>', '[[a]]', undefined, ['<1>', '<2>']).ok, false);
});

test('webTrans preserves native kind and detects indistinguishable original labels', () => {
  const ids = ['{1>', '<2}', '<3>'];
  const native = '{1>foo<2}<3>';
  assert.deepEqual(mapMemoqTarget(native, native, '<3><2}{1>{1>', undefined, ids),
    { ok: true, parts: [{ type: 'markers', markers: ['<3>', '<2}', '{1>', '{1>'] }] });
  assert.equal(mapMemoqTarget(native, native, '<1>', undefined, ids).ok, false);
  const opaque = createMemoqMarkerFillPlan('⟦start⟧foo⟦end⟧', '{1>foo<2}', '⟦end⟧⟦start⟧', undefined, ['{1>', '<2}']);
  assert.equal(opaque.ok && opaque.plan.expectedTarget, '<2}{1>');
  const raw = 'A{x}B{x}C{y}';
  const editor = 'A<1>B<2>C<3>';
  const chips = ['<1>', '<2>', '<3>'];
  const result = createMemoqMarkerFillPlan(raw, editor, '{x} et {x}{y}', undefined, chips);
  assert.equal(result.ok && result.plan.expectedTarget, '<1> et <2><3>');
  assert.equal(mapMemoqTarget(raw, editor, '{x}{x}', undefined, chips).ok, false);
  assert.equal(mapMemoqTarget(raw, editor, '{y}{y}', undefined, chips).ok, true);
});

test('only raw tokens in the protected source positions become native chips', () => {
  const raw = 'Equip <nouveau glyph="vert">sword</> with {literal}.';
  const native = 'Equip <1>sword<2> with {literal}.';
  const ids = ['<1>', '<2>'];
  const result = createMemoqMarkerFillPlan(raw, native, '{literal} puis </><nouveau glyph="vert"></>', undefined, ids);
  assert.equal(result.ok && result.plan.expectedTarget, '{literal} puis <2><1><2>');
  for (const target of ['{literal} {foreign}', '{literal} <nouveau glyph="rouge">']) {
    assert.equal(mapMemoqTarget(raw, native, target, undefined, ids).ok, false);
  }
});

test('memoQ target mapping separates literal content from ordered native sequences', () => {
  assert.deepEqual(mapMemoqTarget(
    '${1}.First\r\n\r\n<color=red>%{name}</c>Second\r\nThird',
    '${1}.First<7><7><color=red>%{name}</c>Second<7>Third',
    '${1}.Premier\n\n<color=red>%{name}</c>Deuxième  \u00A0\nTroisième'
  ), {
    ok: true,
    parts: [
      { type: 'text', text: '${1}.Premier' },
      { type: 'markers', markers: ['<7>', '<7>'] },
      { type: 'text', text: '<color=red>%{name}</c>Deuxième  \u00A0' },
      { type: 'markers', markers: ['<7>'] },
      { type: 'text', text: 'Troisième' }
    ]
  });
});

test('memoQ target mapping preserves native groups for fully protected markup', () => {
  assert.deepEqual(mapMemoqTarget(
    '<b>{name}</b>\nText', '<1><2><3><4>Text', '<b>{name}</b>\nTexte'
  ), {
    ok: true,
    parts: [
      { type: 'markers', markers: ['<1>', '<2>', '<3>', '<4>'] },
      { type: 'text', text: 'Texte' }
    ]
  });
});

test('file-style escaped line breaks are protected only when the webTrans source exposes their marker', () => {
  const line = 'They contain solidified Null Data.';
  const raw = line + '\\r\\nHas a chance to drop when eliminating <span color="red">Sentinel Beacon</>.';
  const target = 'Données.\\r\\nÉliminez <span color="red">la balise</>.';
  for (const [editorBreak, targetBreak] of [['<1>', '<1>'], ['\\r\\n', '\\r\\n']]) {
    const editor = line + editorBreak + 'Has a chance to drop when eliminating <2>Sentinel Beacon<3>.';
    const nativeTarget = 'Données.' + targetBreak + 'Éliminez <2>la balise<3>.';
    for (const sourceColumn of [raw, editor]) {
      for (const targetColumn of [target, nativeTarget]) {
        const result = mapMemoqTarget(sourceColumn, editor, targetColumn, raw);
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.parts.map(p => p.type === 'text' ? p.text : p.markers.join('')).join(''), nativeTarget);
      }
    }
  }
});

test('file tags and short markers can be chosen independently for each column', () => {
  const raw = '<span color="red">Node</> and <link id="7">{2}</>';
  const native = '<1>Node<2> and <3><4><2>';
  const rawTarget = '<span color="red">Nœud</> et <link id="7">{2}</>';
  const nativeTarget = '<1>Nœud<2> et <3><4><2>';
  for (const source of [raw, native]) {
    for (const target of [rawTarget, nativeTarget]) {
      const result = mapMemoqTarget(source, native, target, raw);
      assert.deepEqual(result, { ok: true, parts: [
        { type: 'markers', markers: ['<1>'] }, { type: 'text', text: 'Nœud' },
        { type: 'markers', markers: ['<2>'] }, { type: 'text', text: ' et ' },
        { type: 'markers', markers: ['<3>', '<4>', '<2>'] }
      ] });
    }
  }
  for (const target of [
    nativeTarget.replace('<4>', '<3>'), nativeTarget.replace('<4>', ' <4>'),
    nativeTarget + '{3}', rawTarget.replace('id="7"', 'id="8"'), rawTarget + '<1>'
  ]) {
    assert.equal(mapMemoqTarget(native, native, target, raw).ok, false);
  }
  assert.equal(mapMemoqTarget(native, native, rawTarget).ok, false);
  assert.equal(mapMemoqTarget('Other <b>source</b>', native, nativeTarget).ok, false);
  assert.equal(needsMemoqOriginalTags({ sourceRaw: native, targetRaw: rawTarget }), true);
  assert.equal(needsMemoqOriginalTags({ sourceRaw: native, targetRaw: nativeTarget }), false);
});
