import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPreview } from '../matcher.ts';
import type { PageSegment, TranslationEntry } from '../types.ts';

const entries: TranslationEntry[] = [
  {
    rowIndex: 2,
    sourceRaw: 'Hello',
    sourceNormalized: 'Hello',
    targetRaw: 'Bonjour',
    occurrenceIndex: 1
  },
  {
    rowIndex: 3,
    sourceRaw: 'Hello',
    sourceNormalized: 'Hello',
    targetRaw: 'Salut',
    occurrenceIndex: 2
  }
];

test('buildPreview matches duplicate sources by occurrence index', () => {
  const segments: PageSegment[] = [
    {
      domId: 'hello-1',
      sourceRaw: 'Hello',
      sourceNormalized: 'Hello',
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: []
    },
    {
      domId: 'hello-2',
      sourceRaw: 'Hello',
      sourceNormalized: 'Hello',
      occurrenceIndex: 2,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: []
    }
  ];

  const preview = buildPreview(entries, segments);

  assert.equal(preview.readyToFill, 2);
  assert.equal(preview.items[0]?.translation, 'Bonjour');
  assert.equal(preview.items[1]?.translation, 'Salut');
});

test('buildPreview marks placeholder mismatches', () => {
  const segments: PageSegment[] = [
    {
      domId: 'name-1',
      sourceRaw: 'Hello {name}',
      sourceNormalized: 'Hello {name}',
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: ['{name}']
    }
  ];

  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: 'Hello {name}',
        sourceNormalized: 'Hello {name}',
        targetRaw: 'Bonjour %s',
        occurrenceIndex: 1
      }
    ],
    segments
  );

  assert.equal(preview.placeholderErrors, 1);
  assert.equal(preview.readyToFill, 0);
});
