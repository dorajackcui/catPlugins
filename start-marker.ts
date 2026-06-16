import type { RuntimeSegment } from './content-script-dom.ts';

export interface StartMarker {
  targetElement?: Element | null;
  domId?: string | null;
  setAt?: number;
}

export function findStartSegmentIndex(
  segments: RuntimeSegment[],
  marker: StartMarker | null | undefined
): number | null {
  if (!marker) {
    return null;
  }

  const markerElement = marker.targetElement;
  if (markerElement) {
    const elementIndex = segments.findIndex((segment) =>
      elementsOverlap(segment.targetElement, markerElement)
    );
    if (elementIndex >= 0) {
      return elementIndex;
    }
  }

  if (marker.domId) {
    const domIdIndex = segments.findIndex((segment) => segment.domId === marker.domId);
    if (domIdIndex >= 0) {
      return domIdIndex;
    }
  }

  return null;
}

export function filterSegmentsFromStartMarker<T extends RuntimeSegment>(
  segments: T[],
  marker: StartMarker | null | undefined
): T[] {
  const startIndex = findStartSegmentIndex(segments, marker);
  return startIndex === null ? segments : segments.slice(startIndex);
}

function elementsOverlap(left: Element, right: Element): boolean {
  return (
    left === right ||
    safelyContains(left, right) ||
    safelyContains(right, left)
  );
}

function safelyContains(parent: Element, child: Element): boolean {
  return typeof parent.contains === 'function' && parent.contains(child);
}
