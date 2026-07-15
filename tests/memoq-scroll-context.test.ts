import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContentScrollHelpers } from '../content/scroll.ts';
import type { MemoqDomProfile } from '../platforms/memoq/dom-profile.ts';
import {
  MemoqScrollContextResolver,
  type MemoqScrollEnvironment
} from '../platforms/memoq/scroll-context.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

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
