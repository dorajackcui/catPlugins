import assert from 'node:assert/strict';
import test from 'node:test';

import { read, utils as xlsxUtils, write } from 'xlsx';

import { buildSourceExportWorkbook, parseExcelBuffer } from '../background/excel.ts';
import { buildPreview, classifySegment, createEntryLookup } from '../domain/matcher.ts';
import type { PageSegment } from '../shared/translation-types.ts';

test('parseExcelBuffer falls back to the first two columns when no source/target header is found', () => {
  const workbook = xlsxUtils.book_new();
  const worksheet = xlsxUtils.aoa_to_sheet([
    ['源文', '译文', '备注'],
    ['Hello', 'Bonjour', 'row-2'],
    ['Hello', 'Salut', 'row-3'],
    ['Only source', '', 'skipped']
  ]);
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sheet1');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array' });
  const parsed = parseExcelBuffer(buffer, 'sample.xlsx');

  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries.map((entry) => entry.rowIndex), [1, 2, 3]);
  assert.deepEqual(parsed.entries.map((entry) => entry.sourceRaw), ['源文', 'Hello', 'Hello']);
  assert.deepEqual(parsed.entries.map((entry) => entry.targetRaw), ['译文', 'Bonjour', 'Salut']);
  assert.deepEqual(parsed.entries.map((entry) => entry.occurrenceIndex), [1, 1, 2]);
});

test('parseExcelBuffer uses source/target headers when they are present', () => {
  const workbook = xlsxUtils.book_new();
  const worksheet = xlsxUtils.aoa_to_sheet([
    ['id', 'target', 'note', 'source'],
    [1001, 'Bonjour', 'row-2', 'Hello'],
    [1002, 'Salut', 'row-3', 'Hello']
  ]);
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sheet1');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array' });
  const parsed = parseExcelBuffer(buffer, 'sample.xlsx');

  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((entry) => entry.rowIndex), [2, 3]);
  assert.deepEqual(parsed.entries.map((entry) => entry.sourceRaw), ['Hello', 'Hello']);
  assert.deepEqual(parsed.entries.map((entry) => entry.targetRaw), ['Bonjour', 'Salut']);
  assert.deepEqual(parsed.entries.map((entry) => entry.occurrenceIndex), [1, 2]);
});

test('parseExcelBuffer preserves non-breaking spaces in raw source and target text', () => {
  const workbook = xlsxUtils.book_new();
  const worksheet = xlsxUtils.aoa_to_sheet([
    ['source', 'target'],
    ['Hello\u00A0world', 'Bonjour\u00A0le monde']
  ]);
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sheet1');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array' });
  const parsed = parseExcelBuffer(buffer, 'nbsp.xlsx');

  assert.equal(parsed.entries[0]?.sourceRaw, 'Hello\u00A0world');
  assert.equal(parsed.entries[0]?.sourceNormalized, 'Hello world');
  assert.equal(parsed.entries[0]?.targetRaw, 'Bonjour\u00A0le monde');
});

test('parseExcelBuffer reads exported memoQ row numbers and occurrence indexes', () => {
  const workbook = xlsxUtils.book_new();
  const worksheet = xlsxUtils.aoa_to_sheet([
    ['rowNumber', 'source', 'target', 'occurrenceIndex'],
    ['170', 'Hello', 'Bonjour ligne 170', '3'],
    ['171.', 'Hello', 'Bonjour ligne 171', 4]
  ]);
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sources');

  const buffer = write(workbook, { bookType: 'xlsx', type: 'array' });
  const parsed = parseExcelBuffer(buffer, 'memoq-sources.xlsx');

  assert.deepEqual(parsed.entries.map((entry) => entry.rowNumber), ['170', '171']);
  assert.deepEqual(parsed.entries.map((entry) => entry.occurrenceIndex), [3, 4]);
});

test('parseExcelBuffer skips rows hidden in Excel', () => {
  const workbook = xlsxUtils.book_new();
  const worksheet = xlsxUtils.aoa_to_sheet([
    ['source', 'target'],
    ['A', 'AA'],
    ['B', 'BB'],
    ['C', 'CC']
  ]);
  worksheet['!rows'] = [undefined, undefined, { hidden: true }, undefined];
  xlsxUtils.book_append_sheet(workbook, worksheet, 'Sheet1');

  const buffer = write(workbook, {
    bookType: 'xlsx',
    type: 'array',
    cellStyles: true
  });
  const parsed = parseExcelBuffer(buffer, 'sample.xlsx');

  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((entry) => entry.rowIndex), [2, 4]);
  assert.deepEqual(parsed.entries.map((entry) => entry.sourceRaw), ['A', 'C']);
  assert.deepEqual(parsed.entries.map((entry) => entry.targetRaw), ['AA', 'CC']);
});

test('buildSourceExportWorkbook writes row number source target and occurrence columns', () => {
  const buffer = buildSourceExportWorkbook([
    {
      domId: '272',
      rowNumber: '272',
      sourceRaw: 'Active Privileges<1>Rapid Growth',
      sourceNormalized: 'Active Privileges<1>Rapid Growth',
      occurrenceIndex: 1,
      targetRaw: 'Privileges actifs<1>Croissance rapide',
      isEmptyTarget: false,
      placeholderTokens: ['<1>']
    },
    {
      domId: '273',
      rowNumber: '273',
      sourceRaw: 'Unique Privilege<1>Unlimited Summons',
      sourceNormalized: 'Unique Privilege<1>Unlimited Summons',
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: ['<1>']
    }
  ]);

  const workbook = read(buffer, { type: 'array' });
  const rows = xlsxUtils.sheet_to_json<unknown[]>(workbook.Sheets.Sources, {
    header: 1,
    defval: ''
  });

  assert.deepEqual(rows, [
    ['rowNumber', 'source', 'target', 'occurrenceIndex'],
    ['272', 'Active Privileges<1>Rapid Growth', 'Privileges actifs<1>Croissance rapide', 1],
    ['273', 'Unique Privilege<1>Unlimited Summons', '', 1]
  ]);
});

test('buildSourceExportWorkbook preserves normalized GientTrans placeholders', () => {
  const buffer = buildSourceExportWorkbook([
    {
      domId: '2079851062074056723',
      rowNumber: '19',
      sourceRaw: '{0}看呆了，急忙上前想要抢下一颗苹果。',
      sourceNormalized: '{0}看呆了，急忙上前想要抢下一颗苹果。',
      occurrenceIndex: 1,
      targetRaw: '',
      isEmptyTarget: true,
      placeholderTokens: ['{0}'],
      platform: 'gientrans'
    }
  ]);

  const workbook = read(buffer, { type: 'array' });
  const rows = xlsxUtils.sheet_to_json<unknown[]>(workbook.Sheets.Sources, {
    header: 1,
    defval: ''
  });

  assert.deepEqual(rows, [
    ['rowNumber', 'source', 'target', 'occurrenceIndex'],
    ['19', '{0}看呆了，急忙上前想要抢下一颗苹果。', '', 1]
  ]);
});

test('a translated filtered memoQ export stays on its segment number and native source', () => {
  const segment = {
    domId: '822', rowNumber: '822', sourceRaw: 'In <1>Cradle<2>.', sourceNormalized: 'In <1>Cradle<2>.',
    originalSource: 'In <b>Cradle</b>.', occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true,
    placeholderTokens: ['<1>', '<2>'], platform: 'memoq' as const
  };
  const file = read(buildSourceExportWorkbook([segment]), { type: 'array' });
  const rows = xlsxUtils.sheet_to_json<unknown[]>(file.Sheets.Sources, { header: 1, defval: '' });
  assert.equal(rows[1]?.[4], segment.originalSource);
  rows[1][2] = 'Dans <b>Berceau</b>.';
  file.Sheets.Sources = xlsxUtils.aoa_to_sheet(rows);
  const {entries} = parseExcelBuffer(write(file, { type: 'array', bookType: 'xlsx' }), 'translated.xlsx');
  const options = { autoStopAfterFilledCount: null, validatePlaceholders: true };
  const preview = buildPreview(entries, [
    { ...segment, rowNumber: '777' }, { ...segment, originalSource: undefined, occurrenceIndex: 4 },
    { ...segment, sourceRaw: 'In <9>Cradle<2>.', sourceNormalized: 'In <9>Cradle<2>.' }
  ], options);
  assert.deepEqual(preview.items.map(item => item.status), ['unmatched', 'ready', 'unmatched']);
});

test('Phrase export preserves repeated and reordered native IDs even when their labels are identical', () => {
  const source = '{name} / {name}';
  const target = '{name}＋{name}／{name}';
  const markers = [
    { id: 1, token: '{1}', label: '{name}', offset: 0 },
    { id: 2, token: '{2}', label: '{name}', offset: source.lastIndexOf('{name}') }
  ];
  const original: PageSegment = {
    domId: 'segment-position-50', rowNumber: '51', sourceRaw: source, sourceNormalized: source,
    occurrenceIndex: 1, targetRaw: target, isEmptyTarget: false, placeholderTokens: ['{name}', '{name}'],
    platform: 'phrase', phraseSourceMarkers: markers,
    phraseTargetMarkers: [
      { ...markers[1], offset: 0 }, { ...markers[1], offset: 7 }, { ...markers[0], offset: 14 }
    ]
  };
  const buffer = buildSourceExportWorkbook([original]);
  const file = read(buffer, { type: 'array', cellStyles: true });
  const sheet = file.Sheets.Sources as typeof file.Sheets.Sources & { '!cols'?: { hidden?: boolean }[] };
  const rows = xlsxUtils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  assert.deepEqual(rows[1].slice(0, 4), ['51', source, target, 1]);
  assert.equal(sheet['!cols']?.[4]?.hidden, true);

  const { entries } = parseExcelBuffer(buffer, 'phrase-sources.xlsx');
  const empty = { ...original, targetRaw: '', isEmptyTarget: true, phraseTargetMarkers: undefined };
  const { item, phraseMarkerFillPlan } = classifySegment(createEntryLookup(entries), empty);
  assert.equal(item.status, 'ready');
  assert.deepEqual(phraseMarkerFillPlan?.parts.flatMap(part => part.type === 'tag' ? [part.marker.id] : []), [2, 2, 1]);
  const conflictingMetadata = parseExcelBuffer(buildSourceExportWorkbook([
    original, { ...original, phraseTargetMarkers: original.phraseTargetMarkers?.map(marker => ({ ...marker, token: '{1}' })) }
  ]), 'conflicting-phrase-sources.xlsx');
  assert.equal(buildPreview(conflictingMetadata.entries, [empty]).matched, 0);
  assert.equal(buildPreview(entries, [{ ...empty, rowNumber: '52' }]).matched, 0);
  const renumbered = [{ ...markers[0], id: 4, token: '{4}' }, { ...markers[1], id: 5, token: '{5}' }];
  assert.equal(buildPreview(entries, [{ ...empty, phraseSourceMarkers: renumbered }]).placeholderErrors, 1);

  rows[1][2] = '{name}と{name}';
  file.Sheets.Sources = xlsxUtils.aoa_to_sheet(rows);
  const edited = parseExcelBuffer(write(file, { type: 'array', bookType: 'xlsx' }), 'phrase-edited.xlsx');
  const updated = classifySegment(createEntryLookup(edited.entries), empty);
  assert.equal(updated.item.status, 'ready');
  assert.deepEqual(updated.phraseMarkerFillPlan?.parts.flatMap(part => part.type === 'tag' ? [part.marker.id] : []), [1, 2]);
});
