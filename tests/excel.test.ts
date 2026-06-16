import assert from 'node:assert/strict';
import test from 'node:test';

import { read, utils as xlsxUtils, write } from 'xlsx';

import { buildSourceExportWorkbook, parseExcelBuffer } from '../excel.ts';

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
