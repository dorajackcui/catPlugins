import assert from 'node:assert/strict';
import test from 'node:test';

import {
  START_MARKER_MAX_AGE_MS,
  bindStartMarkerListeners,
  clearStartMarker,
  createStartMarker,
  readFreshStartMarker,
  rememberStartMarkerFromEvent,
  type StartMarkerEnvironment,
  type StartMarkerState
} from '../platforms/start-marker-dom.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

const GIENTRANS_TARGET_SELECTOR =
  'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_TARGET_CELL_SELECTOR = 'td.target-cell';
const PHRASE_TARGET_SELECTOR = '.twe_target';
const PHRASE_ROW_SELECTOR = '.segment-row[role="row"], .segment-row, .twe_segment';
const EDITOR_SURFACE_SELECTOR =
  '#o-editor.online-editor, .editor__table, .segment-row, .twe_segment';

class FakeElement {
  readonly closestResults = new Map<string, FakeElement>();
  readonly queryResults = new Map<string, FakeElement>();
  readonly matchingSelectors = new Set<string>();
  readonly attributes = new Map<string, string>();

  closest<T extends Element = Element>(selector: string): T | null {
    return (this.closestResults.get(selector) as unknown as T | undefined) ?? null;
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    return (this.queryResults.get(selector) as unknown as T | undefined) ?? null;
  }

  matches(selector: string): boolean {
    return this.matchingSelectors.has(selector);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  activeElement: Element | null = null;
  readonly listeners: Array<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
  }> = [];

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.listeners.push({
      type,
      listener,
      capture:
        options === true ||
        (typeof options === 'object' && options.capture === true)
    });
  }

  querySelector<T extends Element = Element>(_selector: string): T | null {
    return null;
  }

  querySelectorAll<T extends Element = Element>(_selector: string): T[] {
    return [];
  }
}

function createHarness(initialNow = 1000): {
  documentRoot: FakeDocument;
  state: StartMarkerState;
  environment: StartMarkerEnvironment;
  setNow(value: number): void;
} {
  const documentRoot = new FakeDocument();
  const state: StartMarkerState = {};
  let now = initialNow;

  return {
    documentRoot,
    state,
    environment: {
      document: documentRoot as unknown as Document,
      state,
      now: () => now,
      isElement: (value): value is Element => value instanceof FakeElement
    },
    setNow(value: number): void {
      now = value;
    }
  };
}

function eventWithTarget(target: FakeElement | null): Event {
  return { target: target as unknown as EventTarget | null } as Event;
}

test('start marker listeners bind once in capture mode', () => {
  const harness = createHarness();

  bindStartMarkerListeners(harness.environment);
  bindStartMarkerListeners(harness.environment);

  assert.equal(harness.state.listenersBound, true);
  assert.deepEqual(
    harness.documentRoot.listeners.map(({ type }) => type),
    ['pointerdown', 'mousedown', 'focusin']
  );
  assert.equal(
    new Set(harness.documentRoot.listeners.map(({ listener }) => listener)).size,
    1
  );
  assert.equal(
    harness.documentRoot.listeners.every(({ capture }) => capture),
    true
  );
});

test('GientTrans marker resolves a target clicked through its table cell', () => {
  const harness = createHarness(1250);
  const clickedElement = new FakeElement();
  const targetCell = new FakeElement();
  const target = new FakeElement();
  clickedElement.closestResults.set(GIENTRANS_TARGET_CELL_SELECTOR, targetCell);
  targetCell.queryResults.set(GIENTRANS_TARGET_SELECTOR, target);
  target.matchingSelectors.add(GIENTRANS_TARGET_SELECTOR);
  target.attributes.set('segid', 'segment-42');

  rememberStartMarkerFromEvent(eventWithTarget(clickedElement), harness.environment);

  assert.equal(harness.state.marker?.targetElement, target as unknown as Element);
  assert.equal(harness.state.marker?.domId, 'segment-42');
  assert.equal(harness.state.marker?.setAt, 1250);
});

test('Phrase marker uses the stable row identifier', () => {
  const harness = createHarness(2100);
  const clickedElement = new FakeElement();
  const target = new FakeElement();
  const row = new FakeElement();
  clickedElement.closestResults.set(PHRASE_TARGET_SELECTOR, target);
  target.closestResults.set(PHRASE_ROW_SELECTOR, row);
  row.attributes.set('data-position', 'phrase-row-7');

  rememberStartMarkerFromEvent(eventWithTarget(clickedElement), harness.environment);

  assert.equal(harness.state.marker?.targetElement, target as unknown as Element);
  assert.equal(harness.state.marker?.domId, 'phrase-row-7');
  assert.equal(harness.state.marker?.setAt, 2100);
});

test('modern memoQ marker keeps profile-based row identity', () => {
  const sourceCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 88 source segment'
    },
    rect: { left: 120 },
    textContent: 'Source'
  });
  const targetCell = fakeElement({
    className: 'ProseMirror',
    attributes: {
      contenteditable: 'true',
      role: 'gridcell',
      'aria-label': 'row 88 target segment'
    },
    rect: { left: 260 },
    textContent: 'Target'
  });
  const row = fakeElement({
    attributes: { role: 'row' },
    children: [sourceCell, targetCell]
  });
  const documentRoot = fakeDocument(
    fakeElement({
      children: [fakeElement({ attributes: { role: 'table' }, children: [row] })]
    })
  );

  const marker = createStartMarker(
    documentRoot,
    targetCell as unknown as Element,
    2200
  );

  assert.equal(marker.targetElement, targetCell as unknown as Element);
  assert.equal(marker.domId, '88');
  assert.equal(marker.setAt, 2200);
});

test('active Phrase target becomes the fallback marker', () => {
  const harness = createHarness(2300);
  const activeElement = new FakeElement();
  const target = new FakeElement();
  const row = new FakeElement();
  activeElement.closestResults.set(PHRASE_TARGET_SELECTOR, target);
  target.closestResults.set(PHRASE_ROW_SELECTOR, row);
  row.attributes.set('id', 'phrase-row-active');
  harness.documentRoot.activeElement = activeElement as unknown as Element;

  const marker = readFreshStartMarker(harness.environment);

  assert.equal(marker?.targetElement, target as unknown as Element);
  assert.equal(marker?.domId, 'phrase-row-active');
  assert.equal(harness.state.marker, marker ?? undefined);
});

test('fresh markers are reused and expired markers are cleared', () => {
  const harness = createHarness(START_MARKER_MAX_AGE_MS + 500);
  const freshMarker = { domId: 'fresh', setAt: 500 };
  harness.state.marker = freshMarker;

  assert.equal(readFreshStartMarker(harness.environment), freshMarker);

  harness.state.marker = { domId: 'expired', setAt: 1 };
  harness.setNow(START_MARKER_MAX_AGE_MS + 2);
  assert.equal(readFreshStartMarker(harness.environment), null);
  assert.equal(harness.state.marker, undefined);
});

test('clicking an editor surface outside a target clears the previous marker', () => {
  const harness = createHarness();
  const editorSurface = new FakeElement();
  const clickedElement = new FakeElement();
  clickedElement.closestResults.set(EDITOR_SURFACE_SELECTOR, editorSurface);
  harness.state.marker = { domId: 'old-marker', setAt: 100 };

  rememberStartMarkerFromEvent(eventWithTarget(clickedElement), harness.environment);

  assert.equal(harness.state.marker, undefined);
});

test('non-element events leave marker state untouched and clear is explicit', () => {
  const harness = createHarness();
  const marker = { domId: 'kept', setAt: 100 };
  harness.state.marker = marker;

  rememberStartMarkerFromEvent(eventWithTarget(null), harness.environment);
  assert.equal(harness.state.marker, marker);

  clearStartMarker(harness.environment);
  assert.equal(harness.state.marker, undefined);
});
