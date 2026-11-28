import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { PhraseRowReader } from '../platforms/phrase/row-reader.ts';
import type { ScrollContext } from '../content/types.ts';

class FakeElement {
  readonly nodeType = 1;
  isConnected = true;
  ownerDocument = document;
  id = '';
  row: FakeElement | null = null;
  target: FakeElement | null = null;
  textContainer: FakeElement | null = null;
  position: { textContent: string } | null = null;
  tagLabel: { textContent: string } | null = null;
  childNodes: Array<FakeElement | ReturnType<typeof textNode>>;
  attributes = new Map<string, string>();

  constructor(private readonly className = '', readonly tagName = 'SPAN', ...children: FakeElement['childNodes']) {
    this.childNodes = children;
  }

  matches(selector: string): boolean { return selector === `.${this.className}`; }
  closest() { return this.row; }

  querySelector(selector: string) {
    if (selector.includes('.te_text_container')) return this.textContainer;
    if (selector === '.twe_target') return this.target;
    if (selector === '.twe_position .position_number') return this.position;
    if (selector === '.tag_metadata_content') return this.tagLabel;
    return null;
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
}

function textNode(textContent: string) {
  return { nodeType: 3, textContent };
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

function setDocument(t: TestContext, overrides: Partial<Document>) {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { querySelector: () => null, ...overrides } as unknown as Document;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 } as typeof Node;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  });
}

function makeReader(overrides: Record<string, unknown> = {}) {
  return new PhraseRowReader({
    sortByVisualPosition: (elements: unknown[]) => elements,
    isElementVisible: () => true,
    ...overrides
  } as never);
}

test('PhraseRowReader serializes literal text and line breaks in native cells', t => {
  const rows: FakeElement[] = [];
  setDocument(t, { querySelectorAll: (() => rows) as never });
  const row = new FakeElement();
  row.id = 'segment-position-37';
  row.position = { textContent: '38' };
  row.textContainer = new FakeElement('', 'DIV', textNode('Hello {name}'), new FakeElement('', 'BR'), textNode('again'));
  row.target = new FakeElement('twe_target');
  row.target.textContainer = new FakeElement('', 'DIV', textNode('Already translated'));
  rows.push(row);
  const reader = makeReader();

  const [segment] = reader.collectVisibleSegments(SCROLL_CONTEXT);

  assert.equal(segment.domId, row.id);
  assert.equal(segment.rowNumber, '38');
  assert.equal(segment.sourceRaw, 'Hello {name}\nagain');
  assert.deepEqual(segment.placeholderTokens, ['{name}']);
  assert.equal(segment.isEmptyTarget, false);
  assert.equal(segment.targetRaw, 'Already translated');
  assert.equal(reader.getEditableValue(segment.targetElement), segment.targetRaw);
});

test('PhraseRowReader resolves a native row only while its number, text and chips still match', t => {
  const rows: FakeElement[] = [];
  setDocument(t, {
    querySelectorAll: (() => rows) as never,
    getElementById: id => (rows.find(row => row.id === id) as unknown as HTMLElement | undefined) ?? null
  });
  const row = new FakeElement();
  row.id = 'segment-position-37';
  row.position = { textContent: '38' };
  row.target = new FakeElement('twe_target');
  row.target.row = row;
  row.target.textContainer = new FakeElement();
  const chip = new FakeElement('te_tag', 'SPAN', textNode('1{days_left}'));
  chip.attributes.set('data-tag-id', '1');
  chip.attributes.set('data-tag-content', '{1}');
  chip.tagLabel = { textContent: '{days_left}' };
  row.textContainer = new FakeElement('', 'DIV', textNode('12'), chip, textNode(' days remaining'));
  rows.push(row);
  const reader = makeReader();

  const [segment] = reader.collectVisibleSegments(SCROLL_CONTEXT);

  assert.equal(segment.sourceRaw, '12{days_left} days remaining');
  assert.deepEqual(segment.phraseSourceMarkers, [
    { id: 1, token: '{1}', label: '{days_left}', offset: 2 }
  ]);
  assert.equal(segment.isEmptyTarget, true);
  assert.equal(reader.resolveTarget(segment), segment.targetElement);

  row.position.textContent = '39';
  assert.equal(reader.resolveTarget(segment), null);
  row.position.textContent = '38';
  chip.attributes.set('data-tag-id', '2');
  assert.equal(reader.resolveTarget(segment), null);
  chip.attributes.delete('data-tag-id');
  assert.deepEqual(reader.collectVisibleSegments(SCROLL_CONTEXT), []);
});

test('PhraseRowReader uses the Phrase scroll container even when the filter returns no rows', t => {
  const scroller = {} as HTMLElement;
  setDocument(t, {
    querySelector: ((selector: string) => selector === '#translation-table-virtual-scroll' ? scroller : null) as never,
    querySelectorAll: ((selector: string) => selector.includes('textarea') ? [{}] : []) as never
  });
  const reader = makeReader({
    toElementScrollContext: (element: HTMLElement) => {
      assert.equal(element, scroller);
      return SCROLL_CONTEXT;
    }
  });

  assert.equal(reader.findScrollContext(), SCROLL_CONTEXT);
  assert.deepEqual(reader.collectVisibleSegments(SCROLL_CONTEXT), []);
});

test('PhraseRowReader falls back to generic editables on pages without a Phrase grid', t => {
  const rows: FakeElement[] = [];
  setDocument(t, { querySelectorAll: ((selector: string) => selector.includes('textarea') ? rows : []) as never });
  rows.push(new FakeElement());
  const reader = makeReader({
    findBestScrollContainer: () => ({}),
    toElementScrollContext: () => SCROLL_CONTEXT,
    isEditableCandidate: () => true,
    findSegmentContainer: () => ({}),
    findSourceText: () => '  Generic source  ',
    getGenericEditableValue: () => ' Existing target ',
    getAbsoluteTop: () => 123.6
  });

  assert.equal(reader.findScrollContext(), SCROLL_CONTEXT);
  const [segment] = reader.collectVisibleSegments(SCROLL_CONTEXT);
  assert.equal(segment.domId, 'Generic source::124');
  assert.equal(segment.sourceRaw, '  Generic source  ');
  assert.equal(segment.targetRaw, ' Existing target ');
  assert.equal(segment.isEmptyTarget, false);
  assert.equal(segment.platform, 'generic');
});
