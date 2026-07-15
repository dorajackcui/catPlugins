import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers } from '../content/dom.ts';
import { ContentScrollHelpers } from '../content/scroll.ts';
import type { ScrollContext } from '../content/types.ts';

test('ContentScriptDomHelpers retains the scroll helper compatibility surface', () => {
  const helpers = new ContentScriptDomHelpers();

  assert.equal(helpers instanceof ContentScrollHelpers, true);
  assert.equal(typeof helpers.findBestScrollContainer, 'function');
  assert.equal(typeof helpers.toWindowScrollContext, 'function');
});

test('element scroll context can move to top and restore the original position', () => {
  const helpers = new ContentScrollHelpers();
  const calls: Array<{ top: number; behavior: string }> = [];
  const container = {
    scrollTop: 320,
    clientHeight: 500,
    scrollHeight: 2000,
    scrollBy({ top }: { top: number }) {
      this.scrollTop += top;
    },
    scrollTo({ top, behavior }: { top: number; behavior: string }) {
      calls.push({ top, behavior });
      this.scrollTop = top;
    }
  };

  const context = helpers.toElementScrollContext(container as unknown as HTMLElement);

  context.scrollToTop();
  assert.equal(container.scrollTop, 0);

  context.restore();
  assert.equal(container.scrollTop, 320);
  assert.deepEqual(calls, [
    { top: 0, behavior: 'auto' },
    { top: 320, behavior: 'auto' }
  ]);
});

test('scroll container detection preserves overflow and height thresholds', () => {
  const previousWindow = globalThis.window;
  let overflowY = 'hidden';
  globalThis.window = {
    getComputedStyle: () => ({ overflowY })
  } as unknown as Window & typeof globalThis;
  const element = {
    clientHeight: 500,
    scrollHeight: 621
  } as HTMLElement;
  const helpers = new ContentScrollHelpers();

  try {
    assert.equal(helpers.isScrollableContainer(element, true), false);
    assert.equal(helpers.isScrollableContainer(element, false), true);

    overflowY = 'auto';
    assert.equal(helpers.isScrollableContainer(element, true), true);

    (element as unknown as { scrollHeight: number }).scrollHeight = 620;
    assert.equal(helpers.isScrollableContainer(element, false), false);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('visual sorting uses vertical position before left position within tolerance', () => {
  const helpers = new ContentScrollHelpers();
  const makeElement = (id: string, top: number, left: number) => ({
    id,
    getBoundingClientRect: () => ({ top, left }) as DOMRect
  }) as unknown as HTMLElement;
  const upper = makeElement('upper', 10, 90);
  const right = makeElement('right', 20, 50);
  const left = makeElement('left', 21, 10);
  const context: ScrollContext = {
    initialTop: 100,
    getTop: () => 100,
    getHeight: () => 600,
    scrollBy: () => undefined,
    scrollToTop: () => undefined,
    isAtBottom: () => false,
    restore: () => undefined
  };

  assert.deepEqual(
    helpers.sortByVisualPosition([right, left, upper], context).map((element) => element.id),
    ['upper', 'left', 'right']
  );
});
