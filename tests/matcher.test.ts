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

test('buildPreview prefers memoQ row numbers over occurrence indexes', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        rowNumber: '170',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        targetRaw: 'Bonjour ligne 170',
        occurrenceIndex: 3
      },
      {
        rowIndex: 3,
        rowNumber: '171',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        targetRaw: 'Bonjour ligne 171',
        occurrenceIndex: 4
      }
    ],
    [
      {
        domId: '171',
        rowNumber: '171',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: []
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(preview.items[0]?.translation, 'Bonjour ligne 171');
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

test('buildPreview keeps non-empty GientTrans targets ready for overwrite', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        targetRaw: 'Bonjour',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'target-1',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: 'Old target',
        isEmptyTarget: false,
        placeholderTokens: [],
        platform: 'gientrans'
      }
    ]
  );

  assert.equal(preview.alreadyTranslated, 0);
  assert.equal(preview.readyToFill, 1);
  assert.equal(preview.items[0]?.status, 'ready');
  assert.equal(preview.items[0]?.translation, 'Bonjour');
});

test('buildPreview matches GientTrans source with default tag tokens against plain Excel source', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '卡皮巴拉 New睁眼瞅了瞅',
        sourceNormalized: '卡皮巴拉 New睁眼瞅了瞅',
        targetRaw: '❮size=38❯Cabichou❮/size❯ NewIl ouvre',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'gientrans-1',
        sourceRaw: '❮size=38❯卡皮巴拉❮/size❯ New睁眼瞅了瞅',
        sourceNormalized: '❮size=38❯卡皮巴拉❮/size❯ New睁眼瞅了瞅',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['❮size=38❯', '❮/size❯'],
        platform: 'gientrans'
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(preview.items[0]?.translation, '❮size=38❯Cabichou❮/size❯ NewIl ouvre');
});

test('buildPreview matches XML-like GientTrans source against tokenized editor source', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '<size=38><color=#C8712F>卡皮巴拉</color></size><size=22><color=#CD5747> New</color></size>\\n睁眼瞅了瞅，嘴巴完全没有要停的意思',
        sourceNormalized: '<size=38><color=#C8712F>卡皮巴拉</color></size><size=22><color=#CD5747> New</color></size>\\n睁眼瞅了瞅，嘴巴完全没有要停的意思',
        targetRaw: '<size=38><color=#C8712F>Cabichou</color></size><size=22><color=#CD5747> New</color></size>\\nIl ouvre les yeux et jette un coup d\'œil, mais sa bouche ne compte pas s\'arrêter',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'gientrans-xml-1',
        sourceRaw: '❮size=38❯❮color=#C8712F❯卡皮巴拉❮/color❯❮/size❯❮size=22❯❮color=#CD5747❯ New❮/color❯❮/size❯\\n睁眼瞅了瞅，嘴巴完全没有要停的意思',
        sourceNormalized: '❮size=38❯❮color=#C8712F❯卡皮巴拉❮/color❯❮/size❯❮size=22❯❮color=#CD5747❯ New❮/color❯❮/size❯\\n睁眼瞅了瞅，嘴巴完全没有要停的意思',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [
          '❮size=38❯',
          '❮color=#C8712F❯',
          '❮/color❯',
          '❮/size❯',
          '❮size=22❯',
          '❮color=#CD5747❯',
          '❮/color❯',
          '❮/size❯',
          '\\n'
        ],
        platform: 'gientrans'
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(
    preview.items[0]?.translation,
    '<size=38><color=#C8712F>Cabichou</color></size><size=22><color=#CD5747> New</color></size>\\nIl ouvre les yeux et jette un coup d\'œil, mais sa bouche ne compte pas s\'arrêter'
  );
});

test('buildPreview still skips non-empty targets for other platforms', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        targetRaw: 'Bonjour',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'phrase-1',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: 'Old target',
        isEmptyTarget: false,
        placeholderTokens: [],
        platform: 'phrase'
      }
    ]
  );

  assert.equal(preview.alreadyTranslated, 1);
  assert.equal(preview.readyToFill, 0);
  assert.equal(preview.items[0]?.status, 'alreadyTranslated');
});

test('buildPreview can skip placeholder validation when disabled', () => {
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
    segments,
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: false
    }
  );

  assert.equal(preview.placeholderErrors, 0);
  assert.equal(preview.readyToFill, 1);
  assert.equal(preview.items[0]?.status, 'ready');
});
