import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/types.ts';
import type {
  FillRunProgress,
  FillSegmentProcessorPort
} from '../content/fill-runner-contracts.ts';
import { FillSegmentProcessor } from '../content/fill-segment-processor.ts';
import type { TranslationEntry } from '../shared/translation-types.ts';

test('FillSegmentProcessor rejects a stale memoQ row before any write', async () => {
  const segment: RuntimeSegment = {
    domId: 'memoq-row-42',
    rowNumber: '42',
    sourceRaw: 'Current memoQ source',
    sourceNormalized: 'Current memoQ source',
    occurrenceIndex: 1,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform: 'memoq'
  };
  const entry: TranslationEntry = {
    rowIndex: 42,
    rowNumber: '42',
    sourceRaw: 'Stale Excel source',
    sourceNormalized: 'Stale Excel source',
    targetRaw: 'Translation',
    occurrenceIndex: 1
  };
  const progressReports: FillRunProgress[] = [];
  const warningLogs: Array<{
    label: string;
    payload: Record<string, unknown>;
  }> = [];
  let fillCalls = 0;

  const port: FillSegmentProcessorPort = {
    runtime: {
      isMemoqActive: () => true,
      async prepareMemoqTrustedInput() {},
      getEditableValue() {
        throw new Error('A rejected memoQ row must not read the target.');
      },
      async fillSegment() {
        fillCalls += 1;
        throw new Error('A rejected memoQ row must not be written.');
      }
    },
    async reportProgress(_runId, progress) {
      progressReports.push(progress);
    },
    assertNotStopped() {},
    async waitWithStopChecks() {},
    async delay() {},
    logInfo() {},
    logWarn(label, payload) {
      warningLogs.push({ label, payload });
    }
  };
  const processor = new FillSegmentProcessor(
    {
      runId: 'run-stale-row',
      entries: [entry],
      fillOptions: {
        autoStopAfterFilledCount: null,
        validatePlaceholders: false
      },
      plannedFillCount: 1
    },
    port
  );

  const directive = await processor.process(segment, {
    scanPass: 1,
    scrollTop: 100,
    scrollMode: 'native'
  });
  const result = processor.createResult();

  assert.equal(directive, undefined);
  assert.equal(fillCalls, 0);
  assert.deepEqual(progressReports, [
    { scannedCount: 1, filledCount: 0, plannedFillCount: 1 }
  ]);
  assert.equal(warningLogs[0]?.label, 'memoQ fill:match-rejected');
  assert.equal(warningLogs[0]?.payload.rowNumber, '42');
  assert.equal(result.filledCount, 0);
  assert.equal(result.preview.items[0]?.status, 'unmatched');
  assert.equal(
    /source does not match the current memoQ source/.test(
      result.preview.items[0]?.reason ?? ''
    ),
    true
  );
});
