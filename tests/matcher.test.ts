import assert from 'node:assert/strict';
import test from 'node:test';

import { applyMemoqPreviewCorrection, buildPreview } from '../domain/matcher.ts';
import type { PageSegment, TranslationEntry } from '../shared/types.ts';

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

test('buildPreview rejects a memoQ row-number match when the Excel source differs', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        rowNumber: '171',
        sourceRaw: 'Old Excel source',
        sourceNormalized: 'Old Excel source',
        targetRaw: 'Wrong translation',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: '171',
        rowNumber: '171',
        sourceRaw: 'Current memoQ source',
        sourceNormalized: 'Current memoQ source',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        platform: 'memoq'
      }
    ]
  );

  assert.equal(preview.readyToFill, 0);
  assert.equal(preview.items[0]?.status, 'unmatched');
  assert.equal(
    /row 171 source does not match/i.test(preview.items[0]?.reason ?? ''),
    true
  );
});

test('memoQ preview correction preserves legitimate unmatched rows', () => {
  const preview = buildPreview([], [
    {
      domId: '171',
      rowNumber: '171',
      sourceRaw: 'Untranslated source',
      sourceNormalized: 'Untranslated source',
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: [],
      platform: 'memoq'
    }
  ]);

  const corrected = applyMemoqPreviewCorrection(preview);

  assert.equal(corrected.totalSegments, 1);
  assert.equal(corrected.items[0]?.status, 'unmatched');
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

test('buildPreview matches Phrase tag clips against plain placeholder source text', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '奋力争抢生效范围增加{1}米。',
        sourceNormalized: '奋力争抢生效范围增加{1}米。',
        targetRaw: '奮力争抢の有効範囲が{1}m増加する。',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'phrase-tag-clip-1',
        sourceRaw: '奋力争抢生效范围增加1{1}米。',
        sourceNormalized: '奋力争抢生效范围增加1{1}米。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1}'],
        platform: 'phrase'
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(preview.items[0]?.translation, '奮力争抢の有効範囲が{1}m増加する。');
});

test('buildPreview matches Phrase repeated placeholder tag clips with different chip numbers', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '无球移动速度+{1}米每秒，运球移动速度+{1}米每秒',
        sourceNormalized: '无球移动速度+{1}米每秒，运球移动速度+{1}米每秒',
        targetRaw: 'オフボール移動速度+{1}m/s、ドリブル移動速度+{1}m/s',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'phrase-repeated-placeholder-tag-clip',
        sourceRaw: '无球移动速度+1{1}米每秒，运球移动速度+2{1}米每秒',
        sourceNormalized: '无球移动速度+1{1}米每秒，运球移动速度+2{1}米每秒',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1}', '{1}'],
        platform: 'phrase'
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(
    preview.items[0]?.translation,
    'オフボール移動速度+{1}m/s、ドリブル移動速度+{1}m/s'
  );
});

test('buildPreview matches Phrase numbered color tag clips against plain XML-like source text', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '布拉德米勒<color=#fa7000>背打转身后</color>，利用转身惯性快速勾手<color=#fa7000>投篮</color>。',
        sourceNormalized: '布拉德米勒<color=#fa7000>背打转身后</color>，利用转身惯性快速勾手<color=#fa7000>投篮</color>。',
        targetRaw: 'ブラッド・ミラーが<color=#fa7000>ポストターン後</color>、ターンの勢いを利用して素早くフック<color=#fa7000>シュート</color>を決める。',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'phrase-color-tag-clip-1',
        sourceRaw: '布拉德米勒1<color=#fa7000>背打转身后2</color>，利用转身惯性快速勾手3<color=#fa7000>投篮4</color>。',
        sourceNormalized: '布拉德米勒1<color=#fa7000>背打转身后2</color>，利用转身惯性快速勾手3<color=#fa7000>投篮4</color>。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [
          '<color=#fa7000>',
          '</color>',
          '<color=#fa7000>',
          '</color>'
        ],
        platform: 'phrase'
      }
    ]
  );

  assert.equal(preview.readyToFill, 1);
  assert.equal(
    preview.items[0]?.translation,
    'ブラッド・ミラーが<color=#fa7000>ポストターン後</color>、ターンの勢いを利用して素早くフック<color=#fa7000>シュート</color>を決める。'
  );
});
