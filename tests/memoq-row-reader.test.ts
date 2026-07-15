import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers, type RuntimeSegment, type ScrollContext } from '../content-script-dom.ts';
import {
  legacyWebtransMemoqProfile,
  modernEditorMemoqProfile
} from '../platforms/memoq/dom-profile.ts';
import { MemoqRowReader } from '../platforms/memoq/row-reader.ts';
import { fakeDocument, fakeElement, type FakeElement } from './memoq-test-dom.ts';

function asElement<T>(element: T): T & HTMLElement {
  return element as T & HTMLElement;
}

function installDocument(root: FakeElement): void {
  globalThis.document = fakeDocument(root);
  globalThis.window = {
    scrollY: 0,
    innerHeight: 600,
    scrollBy: () => undefined,
    scrollTo: () => undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto' })
  } as unknown as Window & typeof globalThis;
}

function scrollContext(): ScrollContext {
  return {
    initialTop: 0,
    getTop: () => 0,
    getHeight: () => 600,
    scrollBy: () => undefined,
    scrollToTop: () => undefined,
    isAtBottom: () => false,
    restore: () => undefined
  };
}

function legacyRow({
  rowNumber,
  source,
  target,
  top
}: {
  rowNumber: string;
  source: string;
  target: string;
  top: number;
}): FakeElement {
  return fakeElement({
    children: [
      fakeElement({ textContent: `${rowNumber}.`, rect: { left: 0, top, width: 30 } }),
      fakeElement({
        className: 'editor-cell',
        rect: { left: 120, top, width: 160, height: 24 },
        children: [fakeElement({ className: 'content-container', textContent: source })]
      }),
      fakeElement({
        className: 'editor-cell',
        rect: { left: 320, top, width: 160, height: 24 },
        children: [fakeElement({ className: 'content-container', textContent: target })]
      })
    ]
  });
}

function modernRow({
  rowNumber,
  source,
  target,
  top
}: {
  rowNumber: string;
  source: string;
  target: string;
  top: number;
}): FakeElement {
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': `row ${rowNumber} source segment`
    },
    rect: { left: 120, top, width: 160, height: 28 },
    textContent: source
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': `row ${rowNumber} target segment`
    },
    rect: { left: 320, top, width: 160, height: 28 },
    textContent: target
  });

  return fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
}

function modernFixture(row: FakeElement): FakeElement {
  const readOnlyPane = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'false',
      role: 'gridcell',
      'aria-label': 'row 1123 target preview'
    },
    rect: { left: 16, top: 24, width: 480, height: 28 },
    textContent: 'Read-only external pane'
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });

  return fakeElement({ children: [readOnlyPane, table] });
}

test('legacy row collection dedupes overlapping recycled rows and preserves the committed copy', () => {
  const emptyDuplicate = legacyRow({
    rowNumber: '8',
    source: 'Repeat source',
    target: '',
    top: 48
  });
  const filledDuplicate = legacyRow({
    rowNumber: '9',
    source: 'Repeat source',
    target: 'Existing target',
    top: 50
  });
  installDocument(fakeElement({ children: [emptyDuplicate, filledDuplicate] }));

  const reader = new MemoqRowReader({
    profile: legacyWebtransMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });

  const segments = reader.collectVisibleSegments(scrollContext());

  assert.equal(segments.length, 1);
  assert.equal(segments[0].rowNumber, '9');
  assert.equal(segments[0].domId, '9');
  assert.equal(segments[0].sourceRaw, 'Repeat source');
  assert.equal(segments[0].sourceNormalized, 'Repeat source');
  assert.equal(segments[0].targetRaw, 'Existing target');
  assert.equal(segments[0].isEmptyTarget, false);
  assert.equal(segments[0].platform, 'memoq');
  assert.equal(segments[0].scanElement, filledDuplicate);
});

test('legacy row collection keeps adjacent rows with the same source', () => {
  const firstRow = legacyRow({
    rowNumber: '8',
    source: 'Repeat source',
    target: '',
    top: 48
  });
  const secondRow = legacyRow({
    rowNumber: '9',
    source: 'Repeat source',
    target: '',
    top: 70
  });
  installDocument(fakeElement({ children: [firstRow, secondRow] }));

  const reader = new MemoqRowReader({
    profile: legacyWebtransMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });

  const segments = reader.collectVisibleSegments(scrollContext());

  assert.deepEqual(segments.map((segment) => segment.rowNumber), ['8', '9']);
});

test('current target and source values are re-read by row number', () => {
  const staleSegment = {
    domId: '21',
    rowNumber: '21',
    sourceRaw: 'Stale source',
    sourceNormalized: 'Stale source',
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: asElement(fakeElement({ className: 'editor-cell', textContent: 'Stale target' })),
    platform: 'memoq'
  } satisfies RuntimeSegment;
  const currentRow = legacyRow({
    rowNumber: '21',
    source: 'Current source',
    target: 'Current target',
    top: 72
  });
  installDocument(fakeElement({ children: [currentRow] }));

  const reader = new MemoqRowReader({
    profile: legacyWebtransMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });
  const cells = reader.findCurrentCellsByRowNumber('21');

  assert.equal(reader.findCurrentTargetByRowNumber('21'), cells?.target);
  assert.equal(reader.getCurrentEditableValue(staleSegment), 'Current target');
  assert.equal(reader.getCurrentSourceValue(staleSegment), 'Current source');
});

test('current target lookup skips zero-size recycled duplicate rows', () => {
  const recycledRow = legacyRow({
    rowNumber: '21',
    source: 'Recycled source',
    target: 'Recycled target',
    top: 72
  });
  const currentRow = legacyRow({
    rowNumber: '21',
    source: 'Current source',
    target: 'Current target',
    top: 96
  });

  for (const cell of recycledRow.querySelectorAll('.editor-cell')) {
    const left = cell.getBoundingClientRect().left;
    cell.getBoundingClientRect = () =>
      ({ left, top: 72, width: 0, height: 0, right: left, bottom: 72 }) as DOMRect;
  }

  installDocument(fakeElement({ children: [recycledRow, currentRow] }));

  const reader = new MemoqRowReader({
    profile: legacyWebtransMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });

  assert.equal(reader.findCurrentTargetByRowNumber('21')?.textContent, 'Current target');
});

test('current target lookup refuses multiple visible rows with the same row number', () => {
  const firstRow = legacyRow({
    rowNumber: '21',
    source: 'First source',
    target: '',
    top: 72
  });
  const secondRow = legacyRow({
    rowNumber: '21',
    source: 'Second source',
    target: '',
    top: 96
  });
  installDocument(fakeElement({ children: [firstRow, secondRow] }));

  const reader = new MemoqRowReader({
    profile: legacyWebtransMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });

  assert.equal(reader.findCurrentTargetByRowNumber('21'), null);
  assert.equal(reader.findCurrentCellsByRowNumber('21'), null);
});

test('modern row collection uses profile rows and ProseMirror gridcells', () => {
  const row = modernRow({
    rowNumber: '1123',
    source: 'Modern source',
    target: 'Modern target',
    top: 96
  });
  const cells = modernEditorMemoqProfile.findCells(asElement(row));
  installDocument(modernFixture(row));

  const reader = new MemoqRowReader({
    profile: modernEditorMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });

  const segments = reader.collectVisibleSegments(scrollContext());

  assert.equal(segments.length, 1);
  assert.equal(segments[0].rowNumber, '1123');
  assert.equal(segments[0].domId, '1123');
  assert.equal(segments[0].sourceRaw, 'Modern source');
  assert.equal(segments[0].targetRaw, 'Modern target');
  assert.equal(segments[0].targetElement, cells?.target);
});

test('modern current cell lookup re-reads source and target through the profile', () => {
  const row = modernRow({
    rowNumber: '1124',
    source: 'Current modern source',
    target: 'Current modern target',
    top: 128
  });
  installDocument(modernFixture(row));

  const reader = new MemoqRowReader({
    profile: modernEditorMemoqProfile,
    helpers: new ContentScriptDomHelpers()
  });
  const staleSegment = {
    domId: '1124',
    rowNumber: '1124',
    sourceRaw: 'Stale source',
    sourceNormalized: 'Stale source',
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: asElement(fakeElement({ className: 'ProseMirror', textContent: 'Stale target' })),
    platform: 'memoq'
  } satisfies RuntimeSegment;
  const cells = reader.findCurrentCellsByRowNumber('1124');

  assert.equal(reader.findCurrentTargetByRowNumber('1124'), cells?.target);
  assert.equal(reader.getCurrentEditableValue(staleSegment), 'Current modern target');
  assert.equal(reader.getCurrentSourceValue(staleSegment), 'Current modern source');
});
