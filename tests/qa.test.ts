import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPlaceholderTokens, placeholdersMatch } from '../qa.ts';
import { normalizeText } from '../utils.ts';

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

test('placeholdersMatch rejects mismatched placeholders', () => {
  assert.equal(placeholdersMatch('Hello {name}', 'Bonjour %s'), false);
  assert.equal(placeholdersMatch('Hello {name}', 'Bonjour {name}'), true);
});

