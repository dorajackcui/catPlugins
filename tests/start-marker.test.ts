import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterSegmentsFromStartMarker,
  filterSegmentsFromPendingStartMarker,
  findStartSegmentIndex,
  hasUnresolvedStartMarker
} from '../start-marker.ts';
import type { RuntimeSegment } from '../content-script-dom.ts';

interface FakeElement {
  children: FakeElement[];
  contains(element: FakeElement): boolean;
}

function makeElement(children: FakeElement[] = []): FakeElement {
  return {
    children,
    contains(element: FakeElement): boolean {
      return this.children.includes(element);
    }
  };
}

function makeSegment(domId: string, targetElement = makeElement()): RuntimeSegment {
  return {
    domId,
    sourceRaw: `source ${domId}`,
    sourceNormalized: `source ${domId}`,
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: targetElement as unknown as HTMLElement,
    platform: 'gientrans'
  };
}

test('findStartSegmentIndex finds the clicked target element', () => {
  const clickedTarget = makeElement();
  const segments = [
    makeSegment('a'),
    makeSegment('b', clickedTarget),
    makeSegment('c')
  ];

  assert.equal(
    findStartSegmentIndex(segments, { targetElement: clickedTarget as unknown as Element }),
    1
  );
  assert.deepEqual(
    filterSegmentsFromStartMarker(segments, {
      targetElement: clickedTarget as unknown as Element
    }).map((segment) => segment.domId),
    ['b', 'c']
  );
});

test('findStartSegmentIndex accepts clicks inside a target element', () => {
  const clickedChild = makeElement();
  const target = makeElement([clickedChild]);
  const segments = [
    makeSegment('a'),
    makeSegment('b', target),
    makeSegment('c')
  ];

  assert.equal(
    findStartSegmentIndex(segments, { targetElement: clickedChild as unknown as Element }),
    1
  );
});

test('findStartSegmentIndex falls back to a stable domId', () => {
  const segments = [makeSegment('a'), makeSegment('b'), makeSegment('c')];

  assert.equal(findStartSegmentIndex(segments, { domId: 'c' }), 2);
});

test('filterSegmentsFromStartMarker leaves segments unchanged when marker is missing', () => {
  const segments = [makeSegment('a'), makeSegment('b')];

  assert.equal(findStartSegmentIndex(segments, { domId: 'missing' }), null);
  assert.deepEqual(filterSegmentsFromStartMarker(segments, { domId: 'missing' }), segments);
});

test('pending start marker suppresses segments until the marker is found', () => {
  const firstPassSegments = [makeSegment('a'), makeSegment('b')];
  const pending = filterSegmentsFromPendingStartMarker(firstPassSegments, { domId: 'c' });

  assert.deepEqual(pending.segments, []);
  assert.equal(pending.startIndex, null);
  assert.equal(pending.matched, false);
  assert.equal(pending.shouldKeepStartMarker, true);

  const secondPassSegments = [makeSegment('b'), makeSegment('c'), makeSegment('d')];
  const matched = filterSegmentsFromPendingStartMarker(secondPassSegments, { domId: 'c' });

  assert.deepEqual(
    matched.segments.map((segment: RuntimeSegment) => segment.domId),
    ['c', 'd']
  );
  assert.equal(matched.startIndex, 1);
  assert.equal(matched.matched, true);
  assert.equal(matched.shouldKeepStartMarker, false);
});

test('hasUnresolvedStartMarker identifies a marker that was never found', () => {
  assert.equal(hasUnresolvedStartMarker({ domId: 'missing' }, true), true);
  assert.equal(hasUnresolvedStartMarker({ domId: 'matched' }, false), false);
  assert.equal(hasUnresolvedStartMarker(null, true), false);
});
