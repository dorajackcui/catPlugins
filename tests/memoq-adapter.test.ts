import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMemoqFillRowFingerprint,
  buildMemoqFillViewportSignature,
  buildMemoqSegmentFingerprint,
  buildMemoqStableSegmentId,
  buildMemoqScanFailureReason,
  canonicalizeMemoqText,
  detectStableMemoqFillViewport,
  evaluateMemoqConfirmation,
  findMemoqFillViewportOverlap
} from '../memoq-adapter.ts';

test('buildMemoqScanFailureReason explains when memoQ cells are missing', () => {
  assert.equal(
    buildMemoqScanFailureReason({
      visibleCellCount: 0,
      visibleRowCount: 0,
      extractedSegmentCount: 0
    }),
    'memoQ scan could not find visible editor cells.'
  );
});

test('buildMemoqScanFailureReason explains when memoQ rows cannot be formed', () => {
  assert.equal(
    buildMemoqScanFailureReason({
      visibleCellCount: 6,
      visibleRowCount: 0,
      extractedSegmentCount: 0
    }),
    'memoQ scan found editor cells, but could not group them into source/target rows.'
  );
});

test('evaluateMemoqConfirmation succeeds when the target cell matches the expected value', () => {
  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Bonjour',
      editorValue: 'Bonjour',
      targetValue: 'Bonjour'
    }),
    {
      confirmed: true
    }
  );
});

test('canonicalizeMemoqText normalizes memoQ render separators and invisible formatting', () => {
  assert.equal(
    canonicalizeMemoqText('  Lumière\u00A0\u200B·achromatique  '),
    'Lumière achromatique'
  );
});

test('evaluateMemoqConfirmation accepts memoQ visual formatting in the committed target', () => {
  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Lumière achromatique',
      editorValue: '',
      targetValue: 'Lumière·achromatique'
    }),
    {
      confirmed: true
    }
  );

  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Lumière achromatique',
      editorValue: '',
      targetValue: 'Lumière\u00A0achromatique\u200B'
    }),
    {
      confirmed: true
    }
  );
});

test('evaluateMemoqConfirmation distinguishes committed and uncommitted memoQ writes', () => {
  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Bonjour',
      editorValue: 'Bonjour',
      targetValue: ''
    }),
    {
      confirmed: false,
      reason: 'memoQ editor accepted the value, but the target cell did not commit the update.'
    }
  );

  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Bonjour',
      editorValue: 'Salut',
      targetValue: ''
    }),
    {
      confirmed: false,
      reason: 'memoQ editor shows a different value after writing.'
    }
  );
});

test('evaluateMemoqConfirmation keeps materially different memoQ targets as failures', () => {
  assert.deepEqual(
    evaluateMemoqConfirmation({
      expectedValue: 'Lumière achromatique',
      editorValue: '',
      targetValue: 'Lumière nocturne'
    }),
    {
      confirmed: false,
      reason: 'memoQ editor did not reflect the requested value.'
    }
  );
});

test('buildMemoqStableSegmentId uses source text and absolute position buckets', () => {
  assert.equal(
    buildMemoqStableSegmentId('Hello world', 96),
    buildMemoqStableSegmentId('Hello world', 101)
  );
  assert.equal(
    buildMemoqStableSegmentId('Hello world', 96) !==
      buildMemoqStableSegmentId('Hello world', 148),
    true
  );
});

test('buildMemoqSegmentFingerprint distinguishes target snapshots for the same row bucket', () => {
  assert.equal(
    buildMemoqSegmentFingerprint('Hello world', 96, '') !==
      buildMemoqSegmentFingerprint('Hello world', 96, 'Bonjour'),
    true
  );
});

test('buildMemoqFillRowFingerprint changes when the committed target changes', () => {
  assert.equal(
    buildMemoqFillRowFingerprint('Hello world', 'Hello world', '') !==
      buildMemoqFillRowFingerprint('Hello world', 'Hello world', 'Bonjour'),
    true
  );
});

test('findMemoqFillViewportOverlap matches the tail of the previous viewport to the head of the next viewport', () => {
  assert.equal(
    findMemoqFillViewportOverlap(
      ['Alpha', 'Beta', 'Gamma', 'Delta'],
      ['Gamma', 'Delta', 'Echo', 'Foxtrot']
    ),
    2
  );
  assert.equal(
    findMemoqFillViewportOverlap(['Alpha', 'Beta'], ['Gamma', 'Delta']),
    0
  );
});

test('detectStableMemoqFillViewport stops after repeated stable viewport signatures', () => {
  assert.equal(
    detectStableMemoqFillViewport([
      buildMemoqFillViewportSignature(['Hello', 'World']),
      buildMemoqFillViewportSignature(['Hello', 'World']),
      buildMemoqFillViewportSignature(['Hello', 'World']),
      buildMemoqFillViewportSignature(['Hello', 'World'])
    ]),
    true
  );
});

test('detectStableMemoqFillViewport stays open when the viewport keeps changing', () => {
  assert.equal(
    detectStableMemoqFillViewport([
      buildMemoqFillViewportSignature(['Hello', 'World']),
      buildMemoqFillViewportSignature(['World', 'Delta']),
      buildMemoqFillViewportSignature(['Delta', 'Echo']),
      buildMemoqFillViewportSignature(['Echo', 'Foxtrot'])
    ]),
    false
  );
});
