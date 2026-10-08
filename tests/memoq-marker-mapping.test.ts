import assert from 'node:assert/strict';
import test from 'node:test';

import { mapMemoqTarget } from '../domain/memoq-marker-mapping.ts';

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
