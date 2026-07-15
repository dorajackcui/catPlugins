import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers } from '../content/dom.ts';
import {
  chooseMemoqAccessibilityTextBoxes,
  MemoqAdapter,
  shouldUseMemoqAccessibilityTextBox
} from '../platforms/memoq/adapter.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

const NBSP = String.fromCharCode(0x00a0);

type ScrollableElement = HTMLElement & {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  scrollBy(input: { top: number }): void;
  scrollTo(input: { top: number }): void;
};

function installChromeRecorder(
  onMessage: (message: unknown) => void,
  response: unknown = { ok: true, data: null }
): () => void {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (nextResponse: unknown) => void) => {
        onMessage(message);
        callback(response);
      }
    }
  };

  return () => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
  };
}

function installImmediateTimer(): () => void {
  const previousWindow = globalThis.window;
  globalThis.window = {
    ...previousWindow,
    innerHeight: 600,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto' }),
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  return () => {
    globalThis.window = previousWindow;
  };
}

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

test('MemoqAdapter.findScrollContext falls back when the modern table is not scrollable', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    textContent: 'Source',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 49 source segment'
    }
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    textContent: '',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 49 target segment'
    }
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const table = Object.assign(fakeElement({
    attributes: { role: 'table' },
    children: [row]
  }), {
    scrollTop: 0,
    clientHeight: 320,
    scrollHeight: 360,
    scrollBy({ top }: { top: number }) {
      this.scrollTop += top;
    },
    scrollTo({ top }: { top: number }) {
      this.scrollTop = top;
    }
  });
  const viewport = Object.assign(fakeElement({
    className: 'memoq-viewport',
    children: [table]
  }), {
    scrollTop: 72,
    clientHeight: 300,
    scrollHeight: 1400,
    scrollBy({ top }: { top: number }) {
      this.scrollTop += top;
    },
    scrollTo({ top }: { top: number }) {
      this.scrollTop = top;
    }
  });
  let selectedScrollRoot: HTMLElement | null = null;
  let bestScrollTargets: HTMLElement[] | null = null;

  globalThis.document = fakeDocument(fakeElement({ children: [viewport] }));
  globalThis.window = {
    innerHeight: 600,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto' })
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      isElementVisible: () => true,
      isScrollableContainer: (element: HTMLElement) =>
        element === (viewport as unknown as HTMLElement),
      findBestScrollContainer: (targets: HTMLElement[]) => {
        bestScrollTargets = targets;
        return viewport as unknown as HTMLElement;
      },
      toElementScrollContext: (container: HTMLElement) => {
        selectedScrollRoot = container;
        const scrollable = container as unknown as ScrollableElement;
        return {
          initialTop: scrollable.scrollTop,
          mode: 'native',
          getTop: () => scrollable.scrollTop,
          getHeight: () => scrollable.clientHeight,
          scrollBy: (delta: number) => scrollable.scrollBy({ top: delta }),
          scrollToTop: () => scrollable.scrollTo({ top: 0 }),
          isAtBottom: () =>
            scrollable.scrollTop + scrollable.clientHeight >=
            scrollable.scrollHeight - 8,
          restore: () => undefined
        };
      }
    } as unknown as ContentScriptDomHelpers);
    const context = adapter.findScrollContext();

    assert.equal(selectedScrollRoot, viewport);
    assert.equal(context?.initialTop, 72);
    const scrollTargets: HTMLElement[] = bestScrollTargets ?? [];
    assert.equal(scrollTargets.includes(targetCell as unknown as HTMLElement), true);
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

test('MemoqAdapter.fillSegment warns when memoQ stores NBSP as plain spaces after a successful fill', async () => {
  const previousDocument = globalThis.document;
  const previousWarn = console.warn;
  const restoreTimer = installImmediateTimer();
  const targetText = { nodeType: 3 as const, textContent: '', parentElement: undefined };
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 42 source segment'
    },
    textContent: 'Source text'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 42 target segment'
    },
    children: [targetText]
  });
  const sourceTextBox = Object.assign(
    fakeElement({
      tagName: 'TEXTAREA',
      textContent: 'Source text'
    }),
    {
      disabled: true,
      readOnly: false,
      value: 'Source text'
    }
  );
  const targetTextBox = Object.assign(
    fakeElement({
      tagName: 'TEXTAREA',
      textContent: 'Bonjour !'
    }),
    {
      disabled: false,
      readOnly: false,
      value: 'Bonjour !'
    }
  );
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const table = fakeElement({
    attributes: { role: 'table' },
    children: [row]
  });
  const warnings: unknown[][] = [];
  const messages: unknown[] = [];
  const restoreChrome = installChromeRecorder((message) => {
    messages.push(message);
    targetText.textContent = 'Bonjour !';
  });
  globalThis.document = fakeDocument(
    fakeElement({ children: [table, sourceTextBox, targetTextBox] })
  );
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const adapter = new MemoqAdapter(new ContentScriptDomHelpers());
    const outcome = await adapter.fillSegment(
      {
        domId: '42',
        rowNumber: '42',
        sourceRaw: 'Source text',
        sourceNormalized: 'Source text',
        occurrenceIndex: 0,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      `Bonjour${NBSP}!`
    );

    assert.equal(outcome.filled, true);
    assert.equal(messages.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], '[Phrase Bulk Fill] memoQ stored this segment without its no-break spaces');
    assert.deepEqual(warnings[0][1], {
      row: '42',
      expected: `Bonjour${NBSP}!`,
      committed: 'Bonjour !'
    });
  } finally {
    console.warn = previousWarn;
    restoreChrome();
    restoreTimer();
    globalThis.document = previousDocument;
  }
});
