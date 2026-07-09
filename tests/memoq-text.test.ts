import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from '../memoq-text.ts';
import { fakeElement, fakeText } from './memoq-test-dom.ts';

const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const MIDDLE_DOT = String.fromCharCode(0x00b7);
const DEGREE = String.fromCharCode(0x00b0);

test('formatMemoqInlineTag converts memoQ tag DOM classes to placeholder markup', () => {
  assert.equal(formatMemoqInlineTag('tag inline-empty editor-char', '1'), '<1>');
  assert.equal(formatMemoqInlineTag('tag inline-open editor-char', '2'), '{2>');
  assert.equal(formatMemoqInlineTag('tag inline-close editor-char', '2'), '<2}');
});

test('memoQ accessibility text can be compared with rendered cell text', () => {
  const target = 'Objectif de points atteint<1>Récupérer des récompenses';

  assert.equal(
    memoQAccessibilityTextToRenderedText(target),
    'Objectif de points atteint1Récupérer des récompenses'
  );
  assert.equal(
    isMemoqCommittedTargetText(
      'Objectif de points atteint1Récupérer des récompenses',
      target
    ),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      'Coffre de radiance Coffre de radiance',
      'Coffre de radiance'
    ),
    false
  );
});

test('isMemoqCommittedTargetText accepts memoQ whitespace display marks in the cell text', () => {
  // With "show whitespace marks" on, memoQ renders spaces as · and nbsp as °.
  assert.equal(
    isMemoqCommittedTargetText(
      `Il·y·a·un·"Lord·Clink"·au·Marché.`.replace(/·/g, MIDDLE_DOT),
      'Il y a un "Lord Clink" au Marché.'
    ),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      `Tu·n'as·pas·assez·de·pièces·d'or°?`
        .replace(/·/g, MIDDLE_DOT)
        .replace(/°/g, DEGREE),
      `Tu n'as pas assez de pièces d'or${NBSP}?`
    ),
    true
  );
  // A genuine degree sign in the translation still matches.
  assert.equal(
    isMemoqCommittedTargetText(
      `25${DEGREE}C·dehors`.replace(/·/g, MIDDLE_DOT),
      `25${DEGREE}C dehors`
    ),
    true
  );
  // Different words still fail.
  assert.equal(
    isMemoqCommittedTargetText(
      `Bonjour·le·monde`.replace(/·/g, MIDDLE_DOT),
      'Bonsoir le monde'
    ),
    false
  );
  // Tag markup is still tolerated alongside display marks.
  assert.equal(
    isMemoqCommittedTargetText(
      `Objectif·atteint1Récupérer`.replace(/·/g, MIDDLE_DOT),
      'Objectif atteint<1>Récupérer'
    ),
    true
  );
});

test('isMemoqCommittedTargetText treats rendered no-break spaces and plain spaces as equal', () => {
  assert.equal(isMemoqCommittedTargetText(`Bonjour${NBSP}!`, `Bonjour${NBSP}!`), true);
  // Rendered cells show plain spaces for nbsp (and vice versa), so the
  // commit check must not distinguish them.
  assert.equal(isMemoqCommittedTargetText('Bonjour !', `Bonjour${NBSP}!`), true);
  assert.equal(
    isMemoqCommittedTargetText(`Bonjour${NBSP}le monde${NARROW_NBSP}!`, 'Bonjour le monde !'),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      `Objectif${NBSP}: 1atteint`,
      `Objectif${NBSP}: <1>atteint`
    ),
    true
  );
});

test('serializeMemoqContent converts inline tag elements while ignoring input elements', () => {
  const root = fakeElement({
    children: [
      fakeText('A'),
      fakeElement({
        className: 'tag inline-open editor-char',
        children: [fakeElement({ className: 'tag-content', textContent: '1' })]
      }),
      fakeText('B'),
      fakeElement({ tagName: 'INPUT', attributes: { value: 'ignored' } }),
      fakeElement({
        className: 'tag inline-close editor-char',
        children: [fakeElement({ className: 'tag-content', textContent: '1' })]
      }),
      fakeText('C')
    ]
  });

  assert.equal(serializeMemoqContent(root as unknown as HTMLElement), 'A{1>}B<1}C');
});
