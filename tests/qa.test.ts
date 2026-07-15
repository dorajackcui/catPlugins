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
