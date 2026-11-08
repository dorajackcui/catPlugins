import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPlaceholderTokens, placeholdersMatch } from '../domain/qa.ts';
import { normalizeText } from '../shared/utils.ts';

test('normalizeText trims and collapses whitespace', () => {
  assert.equal(normalizeText('  Hello   world \n\n again '), 'Hello world again');
});

test('extractPlaceholderTokens keeps source order', () => {
  assert.deepEqual(extractPlaceholderTokens('Hi {name}, <b>%s</b>'), [
    '{name}',
    '<b>',
    '%s',
    '</b>'
  ]);
});

test('extractPlaceholderTokens recognizes memoQ accessibility tag notation', () => {
  assert.deepEqual(extractPlaceholderTokens('{2>Premier Cadeau<1>Recharge<2}'), [
    '{2>',
    '<1>',
    '<2}'
  ]);
});

test('extractPlaceholderTokens recognizes default GientTrans tag notation', () => {
  assert.deepEqual(
    extractPlaceholderTokens('❮size=38❯Cabichou❮/size❯'),
    ['❮size=38❯', '❮/size❯']
  );
});

test('extractPlaceholderTokens canonicalizes GientTrans XML-like tag notation', () => {
  assert.deepEqual(
    extractPlaceholderTokens('<size=38><color=#C8712F>Cabichou</color></size>\\nLine 2'),
    ['❮size=38❯', '❮color=#C8712F❯', '❮/color❯', '❮/size❯', '\\n']
  );
});

test('placeholdersMatch rejects mismatched placeholders', () => {
  assert.equal(placeholdersMatch('Hello {name}', 'Bonjour %s'), false);
  assert.equal(placeholdersMatch('Hello {name}', 'Bonjour {name}'), true);
});

test('GientTrans validates native bracket chips and allows ordinary bracketed text to be translated', () => {
  const known = ['[InputKey:MeleeAttack]'];
  const source = '[说明]长按普攻[InputKey:MeleeAttack]蓄力';
  const target = '[説明]通常攻撃[InputKey:MeleeAttack]を長押しして溜める。';
  assert.deepEqual(extractPlaceholderTokens(source, 'gientrans', known), known);
  assert.equal(placeholdersMatch(source, target, 'gientrans', known), true);
  assert.equal(placeholdersMatch(source, target.replace(known[0], ''), 'gientrans', known), false);
  assert.equal(placeholdersMatch(source, target.replace('MeleeAttack', 'Jump'), 'gientrans', known), false);
});

test('GientTrans QA counts an opaque native chip containing another placeholder as one match', () => {
  const known = ['DO', 'DO%s{0}'];
  assert.deepEqual(extractPlaceholderTokens('DO%s{0}DO%s', 'gientrans', known), ['DO%s{0}', 'DO', '%s']);
  assert.equal(placeholdersMatch('使用DO%s{0}', '使用DO%s', 'gientrans', known), false);
});
