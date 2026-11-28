import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPreview, classifySegment, createEntryLookup } from '../domain/matcher.ts';
import { phraseTargetMatches } from '../domain/phrase-marker-fill.ts';
import type { PageSegment, TranslationEntry } from '../shared/types.ts';
import { normalizeText } from '../shared/utils.ts';

test('webTrans validates chip membership with QA on or off and still checks ordinary placeholders', () => {
  const status = (source: string, chips: string[], target: string, validatePlaceholders: boolean) => {
    const segment: PageSegment = { platform: 'memoq', domId: '906', sourceRaw: source, sourceNormalized: source,
      memoqSourceMarkers: chips, occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [] };
    const entry = { rowIndex: 2, occurrenceIndex: 1, sourceNormalized: source, sourceRaw: source, targetRaw: target };
    return buildPreview([entry], [segment], { autoStopAfterFilledCount: null, validatePlaceholders }).items[0].status;
  };
  for (const qa of [true, false]) {
    const source = 'A<1>B<2>C<3> %s';
    const chips = ['<1>','<2>','<3>'];
    assert.equal(status(source, chips, '<1><2><2><1> %s', qa), 'ready');
    assert.equal(status(source, chips, 'Texte %s', qa), 'ready');
    assert.equal(status(source, chips, '<99> %s', qa), 'placeholderError');
    for (const extra of ['<1>', '{6>', '<7}', '<NewKind/>', '<新标签/>', '{new}']) {
      assert.equal(status('Plain text', [], 'Texte ' + extra, qa), 'placeholderError');
    }
    assert.equal(status('Version {number}', [], 'Version {number}', qa), 'ready');
    assert.equal(status(source, chips, '<2> missing', qa), qa ? 'placeholderError' : 'ready');
  }
});

test('buildPreview handles real memoQ line break markers with default options and placeholder validation', () => {
  for (const [excelSource, memoqSource] of [
    ['First\nSecond', 'First<1>Second'],
    ['${1}.First\n${2}.Second', '${1}.First<1>${2}.Second'],
    ['<color=red>%{name}</c>First\nSecond', '<color=red>%{name}</c>First<1>Second'],
    ['First \r\n Second', 'First <1> Second'],
    ['First\n\nSecond', 'First<1><1>Second']
  ]) {
    const target = excelSource.replace('First', 'Premier').replace('Second', 'Deuxième');
    const lineBreakEntries: TranslationEntry[] = [{
      rowIndex: 2,
      sourceRaw: excelSource,
      sourceNormalized: normalizeText(excelSource),
      targetRaw: target,
      occurrenceIndex: 1
    }];
    const segments: PageSegment[] = [{
      domId: 'memoq-line-break',
      sourceRaw: memoqSource,
      sourceNormalized: memoqSource,
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: ['<1>'],
      platform: 'memoq'
    }];

    const enabled = buildPreview(lineBreakEntries, segments, {
      autoStopAfterFilledCount: null,
      validatePlaceholders: true
    });
    assert.equal(enabled.items[0]?.status, 'ready');
    assert.equal(enabled.items[0]?.translation, target);

    assert.equal(buildPreview(lineBreakEntries, segments).items[0]?.status, 'ready');
  }
});

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

test('buildPreview rejects a translation that duplicates protected breaks', () => {
  const excelSource =
    '1. 活动期间。\\r\\n2. 搭配师可自由选择。\\r\\n3. 若已解锁。\\r\\n4. 可以补购。\\r\\n5. 获得权益。';
  const memoqSource =
    '1. 活动期间。\\r{1>2. 搭配师可自由选择。\\r{1>3. 若已解锁。\\r{1>4. 可以补购。\\r{1>5. 获得权益。';
  const target =
    '1. Pendant.\\r\\n\\r\\n2. Choisissez.\\r\\n\\r\\n3. Débloqué.\\r\\n\\r\\n4. Achat.\\r\\n5. Privilèges.';
  const preview = buildPreview(
    [
      {
        rowIndex: 158,
        sourceRaw: excelSource,
        sourceNormalized: excelSource,
        targetRaw: target,
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'memoq-protected-158',
        sourceRaw: memoqSource,
        sourceNormalized: memoqSource,
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1>', '{1>', '{1>', '{1>'],
        platform: 'memoq'
      }
    ]
  );

  assert.equal(preview.items[0]?.status, 'placeholderError');
  assert.equal(preview.items[0]?.translation, target);
  assert.equal(preview.readyToFill, 0);
  assert.equal(preview.placeholderErrors, 1);
});

test('buildPreview rejects missing markers even with a matching row number', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 158,
        rowNumber: '158',
        sourceRaw: 'Before\\nAfter',
        sourceNormalized: 'Before\\nAfter',
        targetRaw: 'Target',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: '158',
        rowNumber: '158',
        sourceRaw: 'Before{1>After',
        sourceNormalized: 'Before{1>After',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1>'],
        platform: 'memoq'
      }
    ]
  );

  assert.equal(preview.items[0]?.status, 'placeholderError');
  assert.equal(preview.items[0]?.translation, 'Target');
});

test('buildPreview resolves the source before checking its marker mapping', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        rowNumber: '158',
        sourceRaw: 'Unrelated source assigned to imported row 158',
        sourceNormalized: 'Unrelated source assigned to imported row 158',
        targetRaw: 'Wrong translation',
        occurrenceIndex: 1
      },
      {
        rowIndex: 3,
        rowNumber: '999',
        sourceRaw: String.raw`Before\r\nAfter`,
        sourceNormalized: String.raw`Before\r\nAfter`,
        targetRaw: 'Correct translation',
        occurrenceIndex: 7
      }
    ],
    [
      {
        domId: '158',
        rowNumber: '158',
        sourceRaw: String.raw`Before\r{1>After`,
        sourceNormalized: String.raw`Before\r{1>After`,
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1>'],
        platform: 'memoq'
      }
    ]
  );

  assert.equal(preview.items[0]?.status, 'placeholderError');
  assert.equal(preview.items[0]?.translation, 'Correct translation');
});

test('buildPreview enables strictly mapped memoQ marker rows independently', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        sourceRaw: '{ZoneName}{RankName}第{RankIndex}名',
        sourceNormalized: '{ZoneName}{RankName}第{RankIndex}名',
        targetRaw: '{ZoneName}{RankName}第{RankIndex}位',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: 'memoq-marker-row',
        sourceRaw: '<1><2>第<3>名',
        sourceNormalized: '<1><2>第<3>名',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['<1>', '<2>', '<3>'],
        platform: 'memoq'
      }
    ],
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: true
    }
  );

  assert.equal(preview.items[0]?.status, 'ready');
  assert.equal(preview.readyToFill, 1);
});

test('buildPreview enables paired memoQ markers mapped from XML-like Excel tags', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 2,
        rowNumber: '138',
        sourceRaw: '吾王只能<BlueBold>仰视</>着您。',
        sourceNormalized: '吾王只能<BlueBold>仰视</>着您。',
        targetRaw: 'Mon Roi doit <BlueBold>lever les yeux vers vous</>°!',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: '138',
        rowNumber: '138',
        sourceRaw: '吾王只能{1>仰视<2}着您。',
        sourceNormalized: '吾王只能{1>仰视<2}着您。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1>', '<2}'],
        platform: 'memoq'
      }
    ],
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: false
    }
  );

  assert.equal(preview.items[0]?.status, 'ready');
  assert.equal(
    preview.items[0]?.translation,
    'Mon Roi doit <BlueBold>lever les yeux vers vous</>°!'
  );
  assert.equal(preview.readyToFill, 1);
});

test('buildPreview enables XML-like Excel tags flattened by webTrans', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 25,
        rowNumber: '1024',
        sourceRaw: '技能冷却时间降低<span color=\\"#FF8E33\\">5</>秒。',
        sourceNormalized: '技能冷却时间降低<span color=\\"#FF8E33\\">5</>秒。',
        targetRaw:
          'スキルのクールタイムが<span color=\\"#FF8E33\\">5</>秒短縮される。',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: '1024',
        rowNumber: '1024',
        sourceRaw: '技能冷却时间降低<1>5<2>秒。',
        sourceNormalized: '技能冷却时间降低<1>5<2>秒。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['<1>', '<2>'],
        platform: 'memoq'
      }
    ],
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: false
    }
  );

  assert.equal(preview.items[0]?.status, 'ready');
  assert.equal(preview.readyToFill, 1);
});

test('buildPreview rejects a marker-only memoQ source without visible matching evidence', () => {
  const preview = buildPreview(
    [
      {
        rowIndex: 158,
        rowNumber: '158',
        sourceRaw: 'Completely unrelated source',
        sourceNormalized: 'Completely unrelated source',
        targetRaw: 'Wrong translation',
        occurrenceIndex: 1
      }
    ],
    [
      {
        domId: '158',
        rowNumber: '158',
        sourceRaw: '<1>',
        sourceNormalized: '<1>',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['<1>'],
        platform: 'memoq'
      }
    ]
  );

  assert.equal(preview.items[0]?.status, 'unmatched');
  assert.equal(preview.items[0]?.translation, undefined);
});

test('memoQ preview preserves legitimate unmatched rows', () => {
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

  assert.equal(preview.totalSegments, 1);
  assert.equal(preview.items[0]?.status, 'unmatched');
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
    segments,
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: true
    }
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

test('GientTrans matches Excel game tags without row numbers and validates their attributes and closers', () => {
  for (const [source, pageSource, target] of [
    ['<Orange> S1赛季（上半）</>期间限定，随机获得以下外观之一。',
     '❮Orange❯ S1赛季（上半）❮/❯期间限定，随机获得以下外观之一。',
     '<Orange>S1シーズン（前半）</>限定。以下の重ね着からランダムで1つ獲得できる。'],
    ['点击<input key="HardLock"></>开启/关闭锁定',
     '点击❮input key="HardLock"❯❮/❯开启/关闭锁定',
     '<input key="HardLock"></>を押してロックを設定・解除する。']
  ]) {
    const entry = { rowIndex: 2, sourceRaw: source, sourceNormalized: source, targetRaw: target, occurrenceIndex: 1 };
    const segment: PageSegment = {
      domId: 'game', platform: 'gientrans', sourceRaw: pageSource, sourceNormalized: pageSource,
      occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: []
    };
    const status = (translation: string) => buildPreview(
      [{ ...entry, targetRaw: translation }], [segment],
      { validatePlaceholders: true, autoStopAfterFilledCount: null }
    ).items[0]?.status;
    assert.equal(status(target), 'ready');
    assert.equal(status(target.replace('</>', '')), 'placeholderError');
    assert.equal(status(target.replace(/HardLock|Orange/, 'Other')), 'placeholderError');
  }
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

test('Phrase resolves source marker labels to native IDs in workbook target order', () => {
  const source = 'Use {0}{1} to restore {2} points';
  const target = '{1}×{0} restores {2} points';
  const markers = [
    { id: 1, token: '{1}', label: '{0}', offset: source.indexOf('{0}') },
    { id: 2, token: '{2}', label: '{1}', offset: source.indexOf('{1}') },
    { id: 3, token: '{3}', label: '{2}', offset: source.indexOf('{2}') }
  ];
  const entry = { rowIndex: 52, occurrenceIndex: 1, sourceRaw: source, sourceNormalized: source, targetRaw: target };
  const segment: PageSegment = {
    domId: 'segment-position-50', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [],
    platform: 'phrase', phraseSourceMarkers: markers
  };
  const { item, phraseMarkerFillPlan } = classifySegment(createEntryLookup([entry]), segment, {
    autoStopAfterFilledCount: null, validatePlaceholders: true
  });
  assert.equal(item.status, 'ready');
  assert.deepEqual(phraseMarkerFillPlan?.parts, [
    { type: 'tag', marker: markers[1] }, { type: 'text', value: '×' },
    { type: 'tag', marker: markers[0] }, { type: 'text', value: ' restores ' },
    { type: 'tag', marker: markers[2] }, { type: 'text', value: ' points' }
  ]);
  const actualMarkers = [
    { ...markers[1], offset: 0 },
    { ...markers[0], offset: 4 },
    { ...markers[2], offset: target.indexOf('{2}') }
  ];
  const parts = phraseMarkerFillPlan!.parts;
  assert.equal(phraseTargetMatches({ text: target, markers: actualMarkers }, parts), true);
  assert.equal(phraseTargetMatches({ text: target, markers: [] }, parts), false);
  assert.equal(phraseTargetMatches({
    text: target, markers: [{ ...actualMarkers[0], id: 1 }, ...actualMarkers.slice(1)]
  }, parts), false);
});

test('Phrase uses only observed marker spellings, keeping ordinary placeholders as text', () => {
  const source = '第12{number_daysRemaining}天到期，%s';
  const marker = { id: 1, token: '{1}', label: '{number_daysRemaining}', offset: 3 };
  const segment: PageSegment = {
    domId: 'phrase-named', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [],
    platform: 'phrase', phraseSourceMarkers: [marker]
  };
  const entry = { rowIndex: 2, occurrenceIndex: 1, sourceRaw: source, sourceNormalized: source, targetRaw: '{number_daysRemaining}日後に期限切れ、%s' };
  const fillOptions = { autoStopAfterFilledCount: null, validatePlaceholders: true };
  const result = classifySegment(createEntryLookup([entry]), segment, fillOptions);
  assert.equal(result.item.status, 'ready');
  assert.deepEqual(result.phraseMarkerFillPlan?.parts, [
    { type: 'tag', marker }, { type: 'text', value: '日後に期限切れ、%s' }
  ]);
  const otherSource = source.replace('12', '13');
  assert.equal(buildPreview([{ ...entry, sourceRaw: otherSource, sourceNormalized: otherSource }], [segment]).matched, 0);
  assert.equal(buildPreview([{ ...entry, targetRaw: entry.targetRaw.replace('%s', '%d') }], [segment], fillOptions).placeholderErrors, 1);
  const missing = buildPreview([{ ...entry, targetRaw: '日後に期限切れ、%s' }], [segment]);
  assert.equal(missing.readyToFill, 1);
});

test('Phrase can map native markers 1,2,3 to 1,2,2,1', () => {
  const source = '{first}{second}{third}';
  const labels = ['{first}', '{second}', '{third}'];
  const markers = labels.map((label, index) => ({
    id: index + 1, token: `{${index + 1}}`, label, offset: source.indexOf(label)
  }));
  const segment: PageSegment = {
    domId: 'phrase-repeat', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [],
    platform: 'phrase', phraseSourceMarkers: markers
  };
  const entry = { rowIndex: 2, occurrenceIndex: 1, sourceRaw: source, sourceNormalized: source,
    targetRaw: '{first}{second}{second}{first}' };
  const { item, phraseMarkerFillPlan } = classifySegment(createEntryLookup([entry]), segment);
  assert.equal(item.status, 'ready');
  assert.deepEqual(phraseMarkerFillPlan?.parts.map(part => part.type === 'tag' ? part.marker.id : part.value), [1, 2, 2, 1]);
});

test('Phrase will not use scan-local occurrence count to choose between conflicting translations', () => {
  const source = '重复文案';
  const segment: PageSegment = {
    domId: 'segment-position-50', rowNumber: '51', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [], platform: 'phrase'
  };
  const entries = [
    { rowIndex: 30, occurrenceIndex: 1, sourceRaw: source, sourceNormalized: source, targetRaw: '最初' },
    { rowIndex: 52, occurrenceIndex: 2, sourceRaw: source, sourceNormalized: source, targetRaw: '二番目' }
  ];
  const ambiguous = buildPreview(entries, [segment]).items[0];
  assert.equal(ambiguous.status, 'unmatched');
  assert.equal(ambiguous.reason?.includes('different translations'), true);
  const numbered = entries.map((entry, index) => ({ ...entry, rowNumber: index ? '51' : '29' }));
  assert.equal(buildPreview(numbered, [segment]).items[0].translation, '二番目');
  assert.equal(buildPreview(numbered, [{ ...segment, sourceRaw: '另一段', sourceNormalized: '另一段' }]).matched, 0);
  assert.equal(buildPreview(entries.map(entry => ({ ...entry, targetRaw: '翻訳' })), [segment]).readyToFill, 1);
});

test('Phrase maps repeated observed labels to distinct chips and rejects ambiguous literal copies', () => {
  const label = '[[bonus]]';
  const source = `${label} a ${label}`;
  const markers = [
    { id: 4, token: '{4}', label, offset: 0 },
    { id: 8, token: '{8}', label, offset: source.lastIndexOf(label) }
  ];
  const segment: PageSegment = {
    domId: 'phrase-repeated', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true, placeholderTokens: [],
    platform: 'phrase', phraseSourceMarkers: markers
  };
  const entry = { rowIndex: 2, occurrenceIndex: 1, sourceRaw: source, sourceNormalized: source, targetRaw: `${label}${label}` };
  const { phraseMarkerFillPlan } = classifySegment(createEntryLookup([entry]), segment);
  assert.deepEqual(phraseMarkerFillPlan?.parts, markers.map(marker => ({ type: 'tag', marker })));
  const ambiguous = buildPreview([entry], [{ ...segment, phraseSourceMarkers: markers.slice(0, 1) }]);
  assert.equal(/literal text/.test(ambiguous.items[0].reason ?? ''), true);
});
