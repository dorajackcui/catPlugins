import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers } from '../content-script-dom.ts';
import {
  chooseMemoqAccessibilityTextBoxes,
  MemoqAdapter,
  shouldUseMemoqAccessibilityTextBox
} from '../memoq-adapter.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

test('shouldUseMemoqAccessibilityTextBox accepts disabled source textboxes for reading', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: '',
        disabled: true,
        readOnly: false,
        value: 'X-Server<1>PWR Rank',
        textContent: ''
      },
      { requireWritable: false }
    ),
    true
  );
});

test('shouldUseMemoqAccessibilityTextBox rejects disabled target textboxes for writing', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: '',
        disabled: true,
        readOnly: false,
        value: 'X-Server<1>PWR Rank',
        textContent: ''
      },
      { requireWritable: true }
    ),
    false
  );
});

test('shouldUseMemoqAccessibilityTextBox ignores memoQ hidden input', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: 'editorHiddenInput',
        disabled: false,
        readOnly: false,
        value: '',
        textContent: ''
      },
      { requireWritable: false }
    ),
    false
  );
});

test('chooseMemoqAccessibilityTextBoxes pairs a disabled source with a writable target', () => {
  const pair = chooseMemoqAccessibilityTextBoxes([
    {
      id: '',
      disabled: true,
      readOnly: false,
      value: 'X-Server<1>PWR Rank',
      textContent: ''
    },
    {
      id: '',
      disabled: false,
      readOnly: false,
      value: '',
      textContent: ''
    }
  ]);

  assert.equal(pair?.source.value, 'X-Server<1>PWR Rank');
  assert.equal(pair?.target.disabled, false);
});

test('MemoqAdapter.findScrollContext uses the modern memoQ profile scroll root', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [
      fakeElement({
        attributes: { role: 'row' },
        children: [
          fakeElement({
            className: 'ProseMirror',
            textContent: 'Source',
            attributes: {
              contenteditable: 'true',
              role: 'gridcell',
              'aria-label': 'row 48 source segment'
            }
          }),
          fakeElement({
            className: 'ProseMirror',
            textContent: '',
            attributes: {
              contenteditable: 'true',
              role: 'gridcell',
              'aria-label': 'row 48 target segment'
            }
          })
        ]
      })
    ]
  }) as ReturnType<typeof fakeElement> & {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    scrollBy(input: { top: number }): void;
    scrollTo(input: { top: number }): void;
  };
  Object.assign(table, {
    scrollTop: 40,
    clientHeight: 300,
    scrollHeight: 1200,
    scrollBy: ({ top }: { top: number }) => {
      table.scrollTop += top;
    },
    scrollTo: ({ top }: { top: number }) => {
      table.scrollTop = top;
    }
  });
  globalThis.document = fakeDocument(fakeElement({ children: [table] }));
  globalThis.window = {
    innerHeight: 600,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto' })
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter(new ContentScriptDomHelpers());
    const context = adapter.findScrollContext();

    assert.equal(context?.mode, 'native');
    assert.equal(context?.initialTop, 40);
    assert.equal(context?.getTop(), 40);
    context?.scrollBy(25);
    assert.equal(context?.getTop(), 65);
    context?.scrollToTop();
    assert.equal(context?.getTop(), 0);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.getCurrentEditableValue re-resolves the row instead of trusting the scanned element', () => {
  const previousDocument = globalThis.document;
  const staleTargetCell = {
    innerText: 'Text from a recycled row',
    textContent: 'Text from a recycled row',
    childNodes: [],
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null
  };
  const currentTargetCell = {
    innerText: '',
    textContent: '',
    childNodes: [],
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 })
  };
  const sourceCell = {
    innerText: 'Relic Inheritor',
    textContent: 'Relic Inheritor',
    childNodes: [],
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 120, height: 20, width: 120 })
  };
  const rowNumberCell = {
    innerText: '54.',
    textContent: '54.',
    matches: () => false,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, height: 20, width: 40 })
  };
  const row = {
    id: '',
    parentElement: null as unknown,
    children: [rowNumberCell, sourceCell, currentTargetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    getAttribute: () => null
  };
  sourceCell.parentElement = row;
  currentTargetCell.parentElement = row;

  globalThis.document = {
    body: {},
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : []
  } as unknown as Document;

  try {
    const adapter = new MemoqAdapter({} as never);

    assert.equal(
      adapter.getCurrentEditableValue({
        domId: '54',
        rowNumber: '54',
        sourceRaw: 'Relic Inheritor',
        sourceNormalized: 'Relic Inheritor',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: staleTargetCell as never,
        platform: 'memoq'
      }),
      ''
    );

    assert.equal(
      adapter.getCurrentEditableValue({
        domId: 'x',
        rowNumber: undefined,
        sourceRaw: 'Relic Inheritor',
        sourceNormalized: 'Relic Inheritor',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: staleTargetCell as never,
        platform: 'memoq'
      }),
      'Text from a recycled row'
    );
  } finally {
    globalThis.document = previousDocument;
  }
});
