import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPreviewItemsHtml,
  buildPreviewSummaryHtml,
  escapePopupHtml,
  parsePopupFillOptions
} from '../popup/view.ts';
import type { PreviewItem, PreviewResult } from '../shared/types.ts';

function makeItem(
  index: number,
  status: PreviewItem['status'] = 'ready'
): PreviewItem {
  return {
    domId: `segment-${index}`,
    sourceRaw: `Source ${index}`,
    sourceNormalized: `Source ${index}`,
    occurrenceIndex: 1,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    platform: 'phrase',
    status
  };
}

function makePreview(items: PreviewItem[] = []): PreviewResult {
  return {
    totalSegments: 20,
    matched: 18,
    alreadyTranslated: 2,
    placeholderErrors: 1,
    readyToFill: 15,
    skipped: 5,
    items,
    generatedAt: '2026-07-15T00:00:00.000Z'
  };
}

test('escapePopupHtml escapes preview source markup', () => {
  assert.equal(
    escapePopupHtml('<&">'),
    '&lt;&amp;&quot;&gt;'
  );
});

test('buildPreviewSummaryHtml preserves empty and populated summaries', () => {
  assert.equal(
    buildPreviewSummaryHtml(null),
    '<li>Total segments: -</li><li>Matched: -</li><li>Already translated: -</li><li>Tag / placeholder errors: -</li><li>Ready to fill: -</li><li>Skipped: -</li>'
  );
  assert.equal(
    buildPreviewSummaryHtml(makePreview()),
    '<li>Total segments: 20</li><li>Matched: 18</li><li>Already translated: 2</li><li>Tag / placeholder errors: 1</li><li>Ready to fill: 15</li><li>Skipped: 5</li>'
  );
});

test('buildPreviewItemsHtml shows at most fifteen escaped ready sources', () => {
  const items = Array.from({ length: 17 }, (_, index) => makeItem(index + 1));
  items[0] = {
    ...items[0],
    sourceRaw: '<First & source>'
  };
  items.push(makeItem(99, 'alreadyTranslated'));

  const html = buildPreviewItemsHtml(makePreview(items));

  assert.equal((html.match(/<li>/g) ?? []).length, 15);
  assert.equal(html.includes('&lt;First &amp; source&gt;'), true);
  assert.equal(html.includes('Source 16'), false);
  assert.equal(html.includes('Source 99'), false);
});

test('buildPreviewItemsHtml preserves the no-fillable fallback', () => {
  assert.equal(buildPreviewItemsHtml(null), '');
  assert.equal(
    buildPreviewItemsHtml(makePreview([makeItem(1, 'unmatched')])),
    '<li>No fillable segments in the current preview.</li>'
  );
});

test('parsePopupFillOptions preserves blank, validation, and integer rules', () => {
  assert.deepEqual(parsePopupFillOptions('', true), {
    autoStopAfterFilledCount: null,
    validatePlaceholders: true,
    enableMemoqMarkerFill: false
  });
  assert.deepEqual(parsePopupFillOptions(' 12.9 ', false, true), {
    autoStopAfterFilledCount: 12,
    validatePlaceholders: false,
    enableMemoqMarkerFill: true
  });

  let parseError: unknown;
  try {
    parsePopupFillOptions('0', true);
  } catch (error) {
    parseError = error;
  }
  assert.equal(
    parseError instanceof Error ? parseError.message : null,
    'Auto stop count must be a positive number.'
  );
});
