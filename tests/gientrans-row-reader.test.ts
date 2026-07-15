import assert from 'node:assert/strict';
import test from 'node:test';

import { GientTransRowReader } from '../platforms/gientrans/row-reader.ts';
import type { ScrollContext } from '../content/types.ts';

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

test('GientTransRowReader prefers the dedicated table scroll container', () => {
  const previousDocument = globalThis.document;
  const root = {};
  const scrollContainer = {
    scrollHeight: 1200,
    clientHeight: 500
  };
  let convertedElement: unknown;

  globalThis.document = {
    querySelector(selector: string) {
      if (selector === '#o-editor.online-editor') {
        return root;
      }
      if (selector === '.editor__table .el-scrollbar__wrap') {
        return scrollContainer;
      }
      return null;
    }
  } as unknown as Document;

  try {
    const reader = new GientTransRowReader({
      toElementScrollContext(element: unknown) {
        convertedElement = element;
        return SCROLL_CONTEXT;
      }
    } as never);

    assert.equal(reader.isActive(), true);
    assert.equal(reader.findScrollContext(), SCROLL_CONTEXT);
    assert.equal(convertedElement, scrollContainer);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('GientTransRowReader re-resolves a target and reads source tag HTML from its row', () => {
  const previousDocument = globalThis.document;
  const tagHtml =
    '<span class="tagspan"><input type="tag" tfull="{1}"></span>';
  const tagInput = {
    value: '{1}',
    getAttribute(name: string) {
      return name === 'tfull' ? '{1}' : null;
    }
  };
  const tagContainer = {
    outerHTML: tagHtml,
    querySelector: () => tagInput
  };
  const source = {
    querySelectorAll: () => [tagContainer]
  };
  const row = {
    querySelector: () => source
  };
  const firstTarget = {
    getAttribute: () => 'segment-1',
    closest: () => null
  };
  const currentTarget = {
    getAttribute: (name: string) =>
      name === 'segid' ? 'segment-2' : null,
    closest: () => row
  };

  globalThis.document = {
    querySelectorAll: () => [firstTarget, currentTarget]
  } as unknown as Document;

  try {
    const reader = new GientTransRowReader({} as never);

    assert.equal(
      reader.findCurrentTargetBySegmentId('segment-2'),
      currentTarget as never
    );
    assert.deepEqual(
      reader.collectSourceTagHtmlByToken(currentTarget as never),
      new Map([['{1}', [tagHtml]]])
    );
  } finally {
    globalThis.document = previousDocument;
  }
});
