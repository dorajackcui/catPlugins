import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContentScrollHelpers } from '../content/scroll.ts';
import type { MemoqDomProfile } from '../platforms/memoq/dom-profile.ts';
import {
  MemoqScrollContextResolver,
  type MemoqScrollEnvironment
} from '../platforms/memoq/scroll-context.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';
import { createWebTransScrollbar } from '../platforms/memoq/webtrans-scrollbar.ts';

test('webTrans drives the real segment scrollbar to both bounds and restores the original step', async () => {
  let position = 3;
  const lastStep = 5;
  function arrow(direction: 'up' | 'down', delta: number) {
    const button = fakeElement({ className: `vertical-scrollbar-${direction}-button` });
    button.classList.contains = name => name === 'scrollbar-button-enabled' &&
      (delta < 0 ? position > 0 : position < lastStep);
    return Object.assign(button, {
      dispatchEvent(event: Event) {
        if (event.type === 'mousedown') position += delta;
        return true;
      }
    });
  }
  const thumb = Object.assign(fakeElement({ className: 'vertical-scrollbar-thumb' }), {
    style: { get top() { return `${position * 7}px`; } }
  });
  const scrollbar = fakeElement({ className: 'vertical-scrollbar', rect: { height: 150 },
    children: [arrow('up', -1), arrow('down', 1), thumb] });
  const body = fakeElement({ id: 'gridTableBody', children: [
    fakeElement({ tagName: 'TR', children: [fakeElement({ className: 'order', textContent: '814.' })] })
  ] });
  const grid = fakeElement({ id: 'gridContainer', children: [scrollbar, body] });
  const doc = Object.assign(fakeDocument(grid), {
    getElementById: (id: string) => [grid, body].find(element => element.id === id) ?? null,
    defaultView: { MouseEvent: Event }
  });
  const context = createWebTransScrollbar(doc);
  if (!context) throw new Error('webTrans scrollbar was not detected');
  assert.equal(context.hasVerifiedScrollBounds, true);
  assert.equal(context.initialTop, 21);
  let stopChecks = 0;
  await context.scrollToTop(() => { stopChecks++; });
  assert.equal(stopChecks, 3);
  assert.equal(context.getTop(), 0);
  for (let i = 0; i < lastStep; i++) {
    assert.equal(context.isAtBottom(), false);
    await context.scrollBy(150);
  }
  assert.equal(context.isAtBottom(), true);
  await context.restore();
  assert.equal(context.getTop(), context.initialTop);

  // Expanding newly loaded cells can shift the grid without any arrow click.
  position = 0;
  const fromTop = createWebTransScrollbar(doc);
  if (!fromTop) throw new Error('webTrans scrollbar was not detected at the top');
  await fromTop.scrollBy(150);
  position = 4;
  await fromTop.restore();
  assert.equal(position, 0);

  position = lastStep;
  const fromBottom = createWebTransScrollbar(doc);
  if (!fromBottom) throw new Error('webTrans scrollbar was not detected at the bottom');
  await fromBottom.scrollToTop();
  position = 1;
  await fromBottom.restore();
  assert.equal(position, lastStep);
});

interface RecordedEvent {
  receiver: 'focus' | 'target';
  type: string;
  key?: string;
  deltaY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

test('MemoqScrollContextResolver preserves synthetic wheel, PageDown, and Home input', () => {
  const events: RecordedEvent[] = [];
  let focusCount = 0;
  const focusTarget = Object.assign(fakeElement({ attributes: { tabindex: '0' } }), {
    focus: () => {
      focusCount += 1;
    },
    dispatchEvent: (event: Event) => {
      events.push(toRecordedEvent('focus', event));
      return true;
    }
  });
  const target = Object.assign(fakeElement({ children: [focusTarget] }), {
    clientHeight: 320,
    dispatchEvent: (event: Event) => {
      events.push(toRecordedEvent('target', event));
      return true;
    }
  });
  const root = fakeDocument(fakeElement({ children: [target] }));
  const profile: MemoqDomProfile = {
    id: 'modern-editor',
    matches: () => true,
    findVisibleRows: () => [],
    findCells: () => null,
    readRowNumber: () => undefined,
    findScrollRoot: () => null,
    findCurrentTargetByRowNumber: () => null,
    getContentRoot: (cell) => cell,
    getWriteTarget: (cell) => cell,
    createSyntheticScrollTarget: () => target as unknown as HTMLElement
  };
  const helpers = {
    isElementVisible: () => true,
    isScrollableContainer: () => false,
    findBestScrollContainer: () => null,
    toElementScrollContext: () => {
      throw new Error('native scrolling should not be selected');
    }
  } as unknown as ContentScrollHelpers;
  const environment: MemoqScrollEnvironment = {
    root,
    getViewportHeight: () => 600,
    createKeyboardEvent: (type, init) => ({ type, ...init }) as unknown as KeyboardEvent,
    createWheelEvent: (type, init) => ({ type, ...init }) as unknown as WheelEvent
  };
  const context = new MemoqScrollContextResolver(profile, helpers, environment).resolve();

  assert.equal(context?.mode, 'synthetic');
  assert.equal(context?.initialTop, 0);
  assert.equal(context?.getHeight(), 320);

  context?.scrollBy(100);
  assert.equal(context?.getTop(), 240);
  assert.equal(focusCount, 1);
  assert.deepEqual(events, [
    { receiver: 'focus', type: 'wheel', deltaY: 240 },
    { receiver: 'target', type: 'wheel', deltaY: 240 },
    { receiver: 'focus', type: 'keydown', key: 'PageDown' },
    { receiver: 'focus', type: 'keyup', key: 'PageDown' },
    { receiver: 'target', type: 'keydown', key: 'PageDown' },
    { receiver: 'target', type: 'keyup', key: 'PageDown' }
  ]);

  events.length = 0;
  context?.scrollToTop();
  assert.equal(context?.getTop(), 0);
  assert.equal(focusCount, 2);
  assert.deepEqual(events, [
    { receiver: 'focus', type: 'keydown', key: 'Home', ctrlKey: true, metaKey: true },
    { receiver: 'focus', type: 'keyup', key: 'Home', ctrlKey: true, metaKey: true },
    { receiver: 'target', type: 'keydown', key: 'Home', ctrlKey: true, metaKey: true },
    { receiver: 'target', type: 'keyup', key: 'Home', ctrlKey: true, metaKey: true }
  ]);
  assert.equal(context?.isAtBottom(), false);

  context?.restore();
  assert.equal(context?.getTop(), 0);
});

test('MemoqScrollContextResolver ignores an unrelated scrollable TM pane', () => {
  const source = fakeElement({ textContent: 'Source' });
  const target = Object.assign(fakeElement({ textContent: 'Target' }), {
    clientHeight: 280,
    focus: () => undefined,
    dispatchEvent: () => true
  });
  const row = fakeElement({ children: [source, target] });
  const unrelatedTmPane = fakeElement({ textContent: 'TM results' });
  const root = fakeDocument(
    fakeElement({ children: [row, unrelatedTmPane] })
  );
  const profile: MemoqDomProfile = {
    id: 'legacy-webtrans',
    matches: () => true,
    findVisibleRows: () => [row as unknown as HTMLElement],
    findCells: () => ({
      source: source as unknown as HTMLElement,
      target: target as unknown as HTMLElement
    }),
    readRowNumber: () => '158',
    findScrollRoot: () => null,
    findCurrentTargetByRowNumber: () => target as unknown as HTMLElement,
    getContentRoot: (cell) => cell,
    getWriteTarget: (cell) => cell,
    createSyntheticScrollTarget: () => target as unknown as HTMLElement
  };
  let nativeContextCalls = 0;
  const helpers = {
    isElementVisible: () => true,
    isScrollableContainer: () => false,
    findBestScrollContainer: () => unrelatedTmPane as unknown as HTMLElement,
    toElementScrollContext: () => {
      nativeContextCalls += 1;
      throw new Error('The unrelated TM pane must not be selected.');
    }
  } as unknown as ContentScrollHelpers;
  const environment: MemoqScrollEnvironment = {
    root,
    getViewportHeight: () => 600,
    createKeyboardEvent: (type, init) => ({ type, ...init }) as unknown as KeyboardEvent,
    createWheelEvent: (type, init) => ({ type, ...init }) as unknown as WheelEvent
  };

  const context = new MemoqScrollContextResolver(profile, helpers, environment).resolve();

  assert.equal(context?.mode, 'synthetic');
  assert.equal(nativeContextCalls, 0);
});

function toRecordedEvent(
  receiver: RecordedEvent['receiver'],
  event: Event
): RecordedEvent {
  const input = event as Event & Partial<KeyboardEvent & WheelEvent>;

  return {
    receiver,
    type: input.type,
    ...(input.key ? { key: input.key } : {}),
    ...(typeof input.deltaY === 'number' ? { deltaY: input.deltaY } : {}),
    ...(input.ctrlKey ? { ctrlKey: true } : {}),
    ...(input.metaKey ? { metaKey: true } : {})
  };
}
