import assert from 'node:assert/strict';
import test from 'node:test';

import {
  legacyWebtransMemoqProfile,
  modernEditorMemoqProfile,
  selectMemoqDomProfile
} from '../memoq-dom-profile.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

function asElement<T>(element: T): T & HTMLElement {
  return element as T & HTMLElement;
}

const LOCALIZED_ROW_WORD = String.fromCharCode(0x884c);
const LOCALIZED_SOURCE_WORD = String.fromCharCode(0x539f, 0x6587);
const LOCALIZED_TARGET_WORD = String.fromCharCode(0x76ee, 0x6807);

test('legacy memoQ rows are detected and selected when only legacy cells exist', () => {
  const sourceCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    children: [fakeElement({ className: 'content-container', textContent: 'Source' })]
  });
  const targetCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    children: [fakeElement({ className: 'content-container', textContent: 'Target' })]
  });
  const row = fakeElement({
    attributes: { 'aria-rowindex': '48' },
    children: [fakeElement({ textContent: '48.' }), sourceCell, targetCell]
  });
  const root = fakeElement({ children: [row] });
  const documentRoot = fakeDocument(root);

  assert.equal(legacyWebtransMemoqProfile.matches(documentRoot), true);
  assert.equal(selectMemoqDomProfile(documentRoot), legacyWebtransMemoqProfile);
  assert.deepEqual(legacyWebtransMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.deepEqual(legacyWebtransMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(legacyWebtransMemoqProfile.readRowNumber(asElement(row)), '48');
  assert.equal(
    legacyWebtransMemoqProfile.getContentRoot(asElement(sourceCell)),
    sourceCell.querySelector('.content-container')
  );
  assert.equal(legacyWebtransMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '48'), targetCell);
});

test('modern memoQ rows are detected and preferred when present', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 1123 source segment'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 1123 target segment'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const root = fakeElement({ children: [table] });
  const documentRoot = fakeDocument(root);

  assert.equal(modernEditorMemoqProfile.matches(documentRoot), true);
  assert.equal(selectMemoqDomProfile(documentRoot), modernEditorMemoqProfile);
  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.equal(modernEditorMemoqProfile.findScrollRoot(documentRoot), table);
  assert.equal(modernEditorMemoqProfile.createSyntheticScrollTarget(documentRoot), table);
});

test('modern memoQ profile matches a transient contenteditable gridcell before a full row is available', () => {
  const transientCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 1123 source segment'
    },
    textContent: 'Source'
  });
  const documentRoot = fakeDocument(fakeElement({ children: [transientCell] }));

  assert.equal(modernEditorMemoqProfile.matches(documentRoot), true);
  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), []);
});

test('modern memoQ rows read row numbers and distinguish source and target cells from labels', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'line 2048 source segment'
    },
    rect: { left: 320 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'line 2048 target segment'
    },
    rect: { left: 120 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [targetCell, sourceCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [table] }));

  assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), '2048');
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '2048'), targetCell);
  assert.equal(modernEditorMemoqProfile.getContentRoot(asElement(targetCell)), targetCell);
  assert.equal(modernEditorMemoqProfile.getWriteTarget(asElement(targetCell)), targetCell);
});

test('modern memoQ rows support localized accessible labels', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': `${LOCALIZED_ROW_WORD} 88 ${LOCALIZED_SOURCE_WORD}`
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': `${LOCALIZED_ROW_WORD} 88 ${LOCALIZED_TARGET_WORD}`
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [table] }));

  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), '88');
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '88'), targetCell);
});

test('modern memoQ rows distinguish source and target cells from class names', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror memoq-source-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'segment editor'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror memoq-target-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'segment editor'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row', 'aria-label': 'row 302' },
    children: [sourceCell, targetCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [table] }));

  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '302'), targetCell);
});

test('modern memoQ rows read row numbers from title and data attributes', () => {
  const titledSourceCell = fakeElement({
    className: 'ProseMirror source-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      title: 'line 4096'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror target-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const titleRow = fakeElement({
    attributes: { role: 'row' },
    children: [titledSourceCell, targetCell]
  });

  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(titleRow)), '4096');

  const dataRow = fakeElement({
    attributes: { role: 'row', 'data-row-number': '512' },
    children: [
      fakeElement({
        className: 'ProseMirror original-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell'
        },
        rect: { left: 120 },
        textContent: 'Source'
      }),
      fakeElement({
        className: 'ProseMirror target-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell',
          'data-index': 'not the row number'
        },
        rect: { left: 260 },
        textContent: 'Target'
      })
    ]
  });

  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(dataRow)), '512');
});

test('modern memoQ rows prefer explicit row attributes over match percentage titles', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror source-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      title: '100% match'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror target-cell',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row', 'aria-rowindex': '48' },
    children: [sourceCell, targetCell]
  });

  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), '48');
});

test('modern memoQ rows only read data-index when the whole value is numeric', () => {
  const numericDataIndexRow = fakeElement({
    attributes: { role: 'row', 'data-index': '48' },
    children: [
      fakeElement({
        className: 'ProseMirror original-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell'
        },
        rect: { left: 120 },
        textContent: 'Source'
      }),
      fakeElement({
        className: 'ProseMirror target-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell'
        },
        rect: { left: 260 },
        textContent: 'Target'
      })
    ]
  });
  const textDataIndexRow = fakeElement({
    attributes: { role: 'row', 'data-index': 'page 48' },
    children: [
      fakeElement({
        className: 'ProseMirror original-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell'
        },
        rect: { left: 120 },
        textContent: 'Source'
      }),
      fakeElement({
        className: 'ProseMirror target-cell',
        attributes: {
          contenteditable: 'true',
          role: 'gridcell'
        },
        rect: { left: 260 },
        textContent: 'Target'
      })
    ]
  });

  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(numericDataIndexRow)), '48');
  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(textDataIndexRow)), undefined);
});

test('modern memoQ ignores read-only ProseMirror panes outside translation rows', () => {
  const readOnlyPane = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'false',
      role: 'gridcell',
      'aria-label': 'preview target segment'
    },
    textContent: 'Preview'
  });
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 77 source segment'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 77 target segment'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const root = fakeElement({ children: [readOnlyPane, table] });
  const documentRoot = fakeDocument(root);

  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '77'), targetCell);
});

test('legacy profile wins selection when modern only has a transient gridcell', () => {
  const transientModernCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 1123 source segment'
    },
    textContent: 'Source'
  });
  const legacySourceCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'Legacy source'
  });
  const legacyTargetCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    textContent: 'Legacy target'
  });
  const legacyRow = fakeElement({
    attributes: { 'aria-rowindex': '48' },
    children: [fakeElement({ textContent: '48.' }), legacySourceCell, legacyTargetCell]
  });
  const documentRoot = fakeDocument(
    fakeElement({ children: [transientModernCell, legacyRow] })
  );

  assert.equal(modernEditorMemoqProfile.matches(documentRoot), true);
  assert.equal(selectMemoqDomProfile(documentRoot)?.id, 'legacy-webtrans');
});

test('legacy memoQ profile ignores rows without two visible editor cells', () => {
  const loneCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'Orphan'
  });
  const root = fakeElement({ children: [fakeElement({ children: [loneCell] })] });
  const documentRoot = fakeDocument(root);

  assert.deepEqual(legacyWebtransMemoqProfile.findVisibleRows(documentRoot), []);
  assert.equal(legacyWebtransMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '1'), null);
});
