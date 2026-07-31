import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findMemoqStartTargetCell,
  legacyWebtransMemoqProfile,
  modernEditorMemoqProfile,
  readMemoqStartMarkerDomId,
  selectMemoqDomProfile
} from '../platforms/memoq/dom-profile.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

function asElement<T>(element: T): T & HTMLElement {
  return element as T & HTMLElement;
}

const LOCALIZED_ROW_WORD = String.fromCharCode(0x884c);
const LOCALIZED_SOURCE_WORD = String.fromCharCode(0x539f, 0x6587);
const LOCALIZED_TARGET_WORD = String.fromCharCode(0x76ee, 0x6807);

function modernMemoqFixture({
  rowNumber = '1123',
  sourceLabel = `row ${rowNumber} source segment`,
  targetLabel = `row ${rowNumber} target segment`,
  sourceText = 'Source',
  targetText = 'Target',
  cellOrder = 'source-target'
}: {
  rowNumber?: string;
  sourceLabel?: string;
  targetLabel?: string;
  sourceText?: string;
  targetText?: string;
  cellOrder?: 'source-target' | 'target-source';
} = {}) {
  const readOnlyPane = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'false',
      role: 'gridcell',
      'aria-label': `row ${rowNumber} target preview`
    },
    textContent: 'Read-only preview'
  });
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': sourceLabel
    },
    rect: { left: cellOrder === 'source-target' ? 120 : 320 },
    textContent: sourceText
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': targetLabel
    },
    rect: { left: cellOrder === 'source-target' ? 260 : 120 },
    textContent: targetText
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: cellOrder === 'source-target' ? [sourceCell, targetCell] : [targetCell, sourceCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [readOnlyPane, table] }));

  return { documentRoot, readOnlyPane, row, sourceCell, table, targetCell };
}

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
  assert.equal(legacyWebtransMemoqProfile.createSyntheticScrollTarget(documentRoot), targetCell);
});

test('legacy memoQ profile excludes editor cells from the TM comparison pane', () => {
  const sourceCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'Grid source'
  });
  const targetCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    textContent: 'Grid target'
  });
  const gridRow = fakeElement({
    attributes: { 'aria-rowindex': '158' },
    children: [fakeElement({ textContent: '158.' }), sourceCell, targetCell]
  });
  const translationGrid = fakeElement({
    attributes: { 'aria-label': 'Translation grid' },
    children: [gridRow]
  });
  const tmSource = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'TM source'
  });
  const tmTarget = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    textContent: 'TM target'
  });
  const tmRow = fakeElement({ children: [tmSource, tmTarget] });
  const documentRoot = fakeDocument(
    fakeElement({ children: [translationGrid, tmRow] })
  );

  assert.deepEqual(
    legacyWebtransMemoqProfile.findVisibleRows(documentRoot),
    [gridRow]
  );
  assert.equal(
    legacyWebtransMemoqProfile.createSyntheticScrollTarget(documentRoot),
    targetCell
  );
});

test('modern memoQ rows are detected and preferred when present', () => {
  const { documentRoot, row, table } = modernMemoqFixture();

  assert.equal(modernEditorMemoqProfile.matches(documentRoot), true);
  assert.equal(selectMemoqDomProfile(documentRoot), modernEditorMemoqProfile);
  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.equal(modernEditorMemoqProfile.findScrollRoot(documentRoot), table);
  assert.equal(modernEditorMemoqProfile.createSyntheticScrollTarget(documentRoot), table);
});

test('modern memoQ wins when modern and legacy rows are both visible', () => {
  const { table } = modernMemoqFixture();
  const legacySource = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'Legacy source'
  });
  const legacyTarget = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    textContent: 'Legacy target'
  });
  const legacyRow = fakeElement({
    children: [fakeElement({ textContent: '48.' }), legacySource, legacyTarget]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [legacyRow, table] }));

  assert.deepEqual(legacyWebtransMemoqProfile.findVisibleRows(documentRoot), [legacyRow]);
  assert.equal(modernEditorMemoqProfile.findVisibleRows(documentRoot).length, 1);
  assert.equal(selectMemoqDomProfile(documentRoot), modernEditorMemoqProfile);
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
  const { documentRoot, row, sourceCell, targetCell } = modernMemoqFixture({
    rowNumber: '2048',
    sourceLabel: 'line 2048 source segment',
    targetLabel: 'line 2048 target segment',
    cellOrder: 'target-source'
  });

  assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), '2048');
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '2048'), targetCell);
  assert.equal(modernEditorMemoqProfile.getContentRoot(asElement(targetCell)), targetCell);
  assert.equal(modernEditorMemoqProfile.getWriteTarget(asElement(targetCell)), targetCell);
});

test('modern memoQ keeps source and target stable when DOM order is target then source', () => {
  const { row } = modernMemoqFixture({ cellOrder: 'target-source' });

  const cells = modernEditorMemoqProfile.findCells(asElement(row));

  assert.equal(cells?.source.textContent, 'Source');
  assert.equal(cells?.target.textContent, 'Target');
});

test('modern memoQ start marker resolves the row target through the profile', () => {
  const { documentRoot, sourceCell, targetCell } = modernMemoqFixture();

  assert.equal(findMemoqStartTargetCell(documentRoot, asElement(targetCell)), targetCell);
  assert.equal(findMemoqStartTargetCell(documentRoot, asElement(sourceCell)), targetCell);
  assert.equal(readMemoqStartMarkerDomId(documentRoot, asElement(targetCell)), '1123');
  assert.equal(readMemoqStartMarkerDomId(documentRoot, asElement(sourceCell)), '1123');
});

test('modern memoQ rows support localized accessible labels', () => {
  const { documentRoot, row, sourceCell, targetCell } = modernMemoqFixture({
    rowNumber: '88',
    sourceLabel: `${LOCALIZED_ROW_WORD} 88 ${LOCALIZED_SOURCE_WORD}`,
    targetLabel: `${LOCALIZED_ROW_WORD} 88 ${LOCALIZED_TARGET_WORD}`
  });

  assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
  assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
    source: sourceCell,
    target: targetCell
  });
  assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), '88');
  assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, '88'), targetCell);
});

test('modern memoQ rows support English and localized accessible label terms', () => {
  const cases = [
    { rowLabel: 'row', sourceLabel: 'source', targetLabel: 'target' },
    { rowLabel: 'line', sourceLabel: 'original', targetLabel: 'target' },
    {
      rowLabel: LOCALIZED_ROW_WORD,
      sourceLabel: LOCALIZED_SOURCE_WORD,
      targetLabel: LOCALIZED_TARGET_WORD
    }
  ];

  for (const [index, labels] of cases.entries()) {
    const rowNumber = String(index + 81);
    const { documentRoot, row, sourceCell, targetCell } = modernMemoqFixture({
      rowNumber,
      sourceLabel: `${labels.rowLabel} ${rowNumber} ${labels.sourceLabel}`,
      targetLabel: `${labels.rowLabel} ${rowNumber} ${labels.targetLabel}`
    });

    assert.deepEqual(modernEditorMemoqProfile.findVisibleRows(documentRoot), [row]);
    assert.deepEqual(modernEditorMemoqProfile.findCells(asElement(row)), {
      source: sourceCell,
      target: targetCell
    });
    assert.equal(modernEditorMemoqProfile.readRowNumber(asElement(row)), rowNumber);
    assert.equal(modernEditorMemoqProfile.findCurrentTargetByRowNumber(documentRoot, rowNumber), targetCell);
  }
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
  const { documentRoot, row, targetCell } = modernMemoqFixture({
    rowNumber: '77',
    sourceLabel: 'row 77 source segment',
    targetLabel: 'row 77 target segment'
  });

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

test('legacy memoQ start marker resolves the row target through the profile', () => {
  const sourceCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 120 },
    textContent: 'Legacy source'
  });
  const targetCell = fakeElement({
    className: 'editor-cell',
    rect: { left: 260 },
    textContent: 'Legacy target'
  });
  const row = fakeElement({
    attributes: { 'aria-rowindex': '48' },
    children: [fakeElement({ textContent: '48.' }), sourceCell, targetCell]
  });
  const documentRoot = fakeDocument(fakeElement({ children: [row] }));

  assert.equal(findMemoqStartTargetCell(documentRoot, asElement(targetCell)), targetCell);
  assert.equal(findMemoqStartTargetCell(documentRoot, asElement(sourceCell)), targetCell);
  assert.equal(readMemoqStartMarkerDomId(documentRoot, asElement(targetCell)), '48');
  assert.equal(readMemoqStartMarkerDomId(documentRoot, asElement(sourceCell)), '48');
});
