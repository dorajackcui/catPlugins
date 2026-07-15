import assert from 'node:assert/strict';
import test from 'node:test';

import { PhraseRowReader } from '../platforms/phrase/row-reader.ts';
import type { ScrollContext } from '../content/types.ts';

class FakeElement {
  id = '';
  className = '';
  target: FakeElement | null = null;
  scopeRoots: FakeElement[] = [];
  tagChips: FakeElement[] = [];
  attributes = new Map<string, string>();

  matches(selector: string): boolean {
    return selector === '.twe_target' && this.className.includes('twe_target');
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    return selector === '.twe_target' && this.target
      ? (this.target as unknown as T)
      : null;
  }

  querySelectorAll<T extends Element = Element>(selector: string): T[] {
    if (selector.includes('.text-area-source-container')) {
      return this.scopeRoots as unknown as T[];
    }

    if (selector.includes('[contenteditable="false"]')) {
      return this.tagChips as unknown as T[];
    }

    return [];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

const SCROLL_CONTEXT: ScrollContext = {
  initialTop: 0,
  mode: 'native',
  getTop: () => 0,
  getHeight: () => 600,
  scrollBy() {},
  scrollToTop() {},
  isAtBottom: () => true,
  restore() {}
};

test('PhraseRowReader serializes native rows and detects visible tag markup', () => {
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const row = new FakeElement();
  row.id = 'phrase-row-1';
  const target = new FakeElement();
  target.className = 'twe_target';
  const sourceScope = new FakeElement();
  sourceScope.tagChips = [new FakeElement()];
  row.target = target;
  row.scopeRoots = [sourceScope];

  globalThis.HTMLElement = FakeElement as never;
  globalThis.document = {
    querySelectorAll(selector: string) {
      return selector.includes('.segment-row') ? [row] : [];
    }
  } as unknown as Document;

  try {
    const reader = new PhraseRowReader({
      sortByVisualPosition: (elements: unknown[]) => elements,
      isElementVisible: () => true,
      readTextBySelectors: (
        element: FakeElement,
        selectors: string[]
      ) =>
        element === row && selectors.some((selector) => selector.includes('source'))
          ? 'Hello {name}'
          : '',
      getAbsoluteTop: () => 100
    } as never);

    const segments = reader.collectVisibleSegments(SCROLL_CONTEXT);

    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.domId, 'phrase-row-1');
    assert.equal(segments[0]?.sourceRaw, 'Hello {name}');
    assert.equal(segments[0]?.sourceNormalized, 'Hello {name}');
    assert.equal(segments[0]?.targetRaw, '');
    assert.equal(segments[0]?.isEmptyTarget, true);
    assert.deepEqual(segments[0]?.placeholderTokens, ['{name}']);
    assert.equal(segments[0]?.targetElement, target as never);
    assert.equal(segments[0]?.platform, 'phrase');
    assert.equal(segments[0]?.phraseUsesTagMarkup, true);
    assert.equal(reader.getEditableValue(target as never), '');
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
  }
});

test('PhraseRowReader falls back to generic editable discovery', () => {
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const target = new FakeElement();
  const container = new FakeElement();

  globalThis.HTMLElement = FakeElement as never;
  globalThis.document = {
    querySelectorAll(selector: string) {
      if (selector.includes('.segment-row')) {
        return [];
      }

      return selector.includes('textarea') ? [target] : [];
    }
  } as unknown as Document;

  try {
    const reader = new PhraseRowReader({
      sortByVisualPosition: (elements: unknown[]) => elements,
      isElementVisible: () => true,
      isEditableCandidate: () => true,
      findSegmentContainer: () => container,
      findSourceText: () => '  Generic source  ',
      getGenericEditableValue: () => ' Existing target ',
      getAbsoluteTop: () => 123.6
    } as never);

    const segments = reader.collectVisibleSegments(SCROLL_CONTEXT);

    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.domId, 'Generic source::124');
    assert.equal(segments[0]?.sourceRaw, '  Generic source  ');
    assert.equal(segments[0]?.sourceNormalized, 'Generic source');
    assert.equal(segments[0]?.targetRaw, ' Existing target ');
    assert.equal(segments[0]?.isEmptyTarget, false);
    assert.equal(segments[0]?.platform, 'generic');
    assert.equal(segments[0]?.targetElement, target as never);
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
  }
});

test('PhraseRowReader resolves the best scroll container from editor candidates', () => {
  const previousDocument = globalThis.document;
  const candidate = new FakeElement();
  const container = new FakeElement();
  let receivedCandidates: unknown[] = [];

  globalThis.document = {
    querySelectorAll: () => [candidate]
  } as unknown as Document;

  try {
    const reader = new PhraseRowReader({
      findBestScrollContainer: (candidates: unknown[]) => {
        receivedCandidates = candidates;
        return container;
      },
      toElementScrollContext: () => SCROLL_CONTEXT
    } as never);

    const scrollContext = reader.findScrollContext();

    assert.deepEqual(receivedCandidates, [candidate]);
    assert.equal(scrollContext, SCROLL_CONTEXT);
  } finally {
    globalThis.document = previousDocument;
  }
});
