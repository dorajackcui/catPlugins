import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterSegmentsFromStartMarker,
  findStartSegmentIndex
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
