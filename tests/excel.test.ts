import assert from 'node:assert/strict';
import test from 'node:test';

import { utils as xlsxUtils, write } from 'xlsx';

import { parseExcelBuffer } from '../excel.ts';

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
