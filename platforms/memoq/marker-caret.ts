import { canonicalMarkerState, MemoqMarkerTargetChangedError } from './marker-state-monitor.ts';
import { serializeMemoqContentExact } from './text.ts';

/** Locate a text boundary by its offset in the row's exact serialized value. */
export function findMemoqCaretPoint(
  content: HTMLElement,
  expectedValue: string,
  textOffset: number
): { x: number; y: number } | null {
  const boundaries: Array<{ node: Text; offset: number }> = [];
  const actual = serializeMemoqContentExact(content, (node, start) => {
    const offset = textOffset - start;
    if (node.length > 0 && offset >= 0 && offset <= node.length) {
      boundaries.push({ node, offset });
    }
  });
  if (canonicalMarkerState(actual) !== expectedValue) {
    throw new MemoqMarkerTargetChangedError('The memoQ target changed before positioning the marker cursor.');
  }

  const doc = content.ownerDocument;
  // CRLF can compare equal but use a different DOM offset. Use keyboard
  // navigation whenever an exact text-node boundary cannot be established.
  if (actual !== expectedValue || !doc || !(doc.caretPositionFromPoint || doc.caretRangeFromPoint)) {
    return null;
  }

  for (const { node, offset } of boundaries) {
    const range = doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (!rect.height) continue;

    const y = rect.top + rect.height / 2;
    // At a style, wrap or bidi boundary either side can hit another atom.
    // Only click a point which the browser maps back to this exact caret.
    for (const x of [rect.left + 1, rect.left - 1, rect.left]) {
      if (!content.contains(doc.elementFromPoint(x, y))) continue;
      if (doc.caretPositionFromPoint) {
        const hit = doc.caretPositionFromPoint(x, y);
        if (hit?.offsetNode === node && hit.offset === offset) return { x, y };
      } else {
        const hit = doc.caretRangeFromPoint(x, y);
        if (hit?.startContainer === node && hit.startOffset === offset) return { x, y };
      }
    }
  }
  return null;
}
