import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackgroundRequestHandler,
  type BackgroundRequestHandlerPort
} from '../background/request-handler.ts';
import type { RuntimeStateUpdate } from '../background/storage.ts';
import { DEFAULT_FILL_OPTIONS } from '../domain/fill-options.ts';
import { DEFAULT_RUN_STATE } from '../domain/run-state.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  FillRunResult,
  PageSegment,
  PreviewResult,
  RuntimeState,
  TranslationEntry
} from '../shared/types.ts';

const ENTRY: TranslationEntry = {
  rowIndex: 2,
  sourceRaw: 'Source text',
  sourceNormalized: 'Source text',
  targetRaw: 'Translated text',
  occurrenceIndex: 1
};

const SEGMENT: PageSegment = {
  domId: 'segment-1',
  sourceRaw: 'Source text',
  sourceNormalized: 'Source text',
  occurrenceIndex: 1,
  targetRaw: '',
  isEmptyTarget: true,
  placeholderTokens: [],
  platform: 'phrase'
};

function makePreview(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    totalSegments: 1,
    matched: 1,
    alreadyTranslated: 0,
    placeholderErrors: 0,
    readyToFill: 1,
    skipped: 0,
    items: [],
    generatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides
  };
}

function makeRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    translationEntries: [],
    previewResult: null,
    uploadMeta: null,
    fillOptions: { ...DEFAULT_FILL_OPTIONS },
    runState: { ...DEFAULT_RUN_STATE },
    ...overrides
  };
}

function cloneUpdate(update: RuntimeStateUpdate): RuntimeStateUpdate {
  return {
    ...update,
    fillOptions: update.fillOptions
      ? { ...update.fillOptions }
      : update.fillOptions,
    runState: update.runState ? { ...update.runState } : update.runState
  };
}

function createHarness(options: {
  state?: RuntimeState;
  tab?: { id: number; url?: string };
  frames?: Array<{ frameId: number; parentFrameId: number; url?: string }>;
  responses?: unknown[];
} = {}) {
  let state = options.state ?? makeRuntimeState();
  const responses = [...(options.responses ?? [])];
  const events: string[] = [];
  const writes: RuntimeStateUpdate[] = [];
  const scriptCalls: Array<{
    tabId: number;
    files: string[];
    options?: { allFrames?: boolean; frameIds?: number[] };
  }> = [];
  const tabMessages: Array<{
    tabId: number;
    message: unknown;
    options?: { frameId?: number };
  }> = [];
  const keepAliveCalls: Array<number | undefined> = [];
  const writeTextCalls: Array<{
    tabId: number;
    x: number;
    y: number;
    text: string;
  }> = [];
  const sequenceCalls: Array<{
    tabId: number;
    x: number;
    y: number;
    operations: unknown[];
  }> = [];
  const prepareCalls: number[] = [];
  const infoLogs: Array<{
    message: string;
    payload: Record<string, unknown>;
  }> = [];

  const port: BackgroundRequestHandlerPort = {
    debuggerInput: {
      keepAlive(tabId) {
        keepAliveCalls.push(tabId);
      },
      async writeText(tabId, x, y, text) {
        writeTextCalls.push({ tabId, x, y, text });
      },
      async runSequence(tabId, x, y, operations) {
        sequenceCalls.push({ tabId, x, y, operations });
      },
      async prepare(tabId) {
        prepareCalls.push(tabId);
      }
    },
    async queryActiveTab() {
      events.push('query-tab');
      return (
        options.tab ?? {
          id: 42,
          url: 'https://app.phrase.com/editor/project-1'
        }
      );
    },
    async executeScript(tabId, files, scriptOptions) {
      events.push('execute-script');
      scriptCalls.push({ tabId, files, options: scriptOptions });
    },
    async getAllFrames() {
      events.push('get-frames');
      return options.frames ?? [];
    },
    async sendTabMessage<TRequest, TResponse>(tabId: number, message: TRequest, messageOptions?: { frameId?: number }): Promise<TResponse> {
      events.push(`send:${(message as { type?: string }).type ?? 'unknown'}`);
      tabMessages.push({ tabId, message, options: messageOptions });
      if (!responses.length) {
        throw new Error('No scripted tab response.');
      }
      return responses.shift() as TResponse;
    },
    async readRuntimeState() {
      events.push('read-state');
      return state;
    },
    async writeRuntimeState(update) {
      const copiedUpdate = cloneUpdate(update);
      events.push(
        `write-state:${copiedUpdate.runState?.phase ?? 'partial'}`
      );
      writes.push(copiedUpdate);
      state = {
        ...state,
        ...update
      };
    },
    now: () => new Date('2026-07-15T12:34:56.000Z'),
    logInfo(message, payload) {
      infoLogs.push({ message, payload });
    }
  };

  return {
    handler: new BackgroundRequestHandler(port),
    events,
    writes,
    scriptCalls,
    tabMessages,
    keepAliveCalls,
    writeTextCalls,
    sequenceCalls,
    prepareCalls,
    infoLogs,
    getState: () => state
  };
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

test('BackgroundRequestHandler returns popup state without exposing translations', async () => {
  const state = makeRuntimeState({
    translationEntries: [ENTRY],
    uploadMeta: {
      fileName: 'translations.xlsx',
      entryCount: 1,
      uploadedAt: '2026-07-15T00:00:00.000Z',
      sheetName: 'Sheet1'
    },
    previewResult: makePreview()
  });
  const harness = createHarness({ state });

  const response = await harness.handler.handle({ type: 'GET_STATE' });

  assert.equal(response.ok, true);
  assert.deepEqual(response.ok ? response.data : null, {
    uploadMeta: state.uploadMeta,
    previewResult: state.previewResult,
    fillOptions: state.fillOptions,
    runState: state.runState
  });
});

test('BackgroundRequestHandler runs Preview in the detected Phrase editor frame', async () => {
  const harness = createHarness({
    state: makeRuntimeState({ translationEntries: [ENTRY] }),
    tab: {
      id: 42,
      url: 'https://cloud.memsource.com/web/job/job-1/translate'
    },
    frames: [
      {
        frameId: 7,
        parentFrameId: 0,
        url: 'https://editor.memsource.com/twe/translation/job/job-1'
      }
    ],
    responses: [{ ok: true, data: [SEGMENT] } satisfies ApiResponse<PageSegment[]>]
  });

  const response = await harness.handler.handle({
    type: 'RUN_PREVIEW',
    payload: {
      fillOptions: {
        autoStopAfterFilledCount: null,
        validatePlaceholders: false
      }
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(harness.scriptCalls, [
    {
      tabId: 42,
      files: ['content-script.js'],
      options: { allFrames: true }
    }
  ]);
  const runningState = harness.writes[0]?.runState;
  assert.equal(runningState?.kind, 'preview');
  assert.equal(runningState?.frameId, 7);
  assert.deepEqual(harness.tabMessages, [
    {
      tabId: 42,
      message: {
        type: 'CONTENT_SCAN',
        payload: { runId: runningState?.runId ?? '' }
      },
      options: { frameId: 7 }
    }
  ]);
  assert.equal(harness.getState().previewResult?.readyToFill, 1);
  assert.equal(harness.getState().runState.phase, 'idle');
  assert.equal(harness.getState().runState.scannedCount, 1);
  assert.equal(
    harness.getState().runState.message,
    'Preview ready. 1 segment(s) can be filled.'
  );
});

test('BackgroundRequestHandler keeps memoQ full-scan Fill options and final progress', async () => {
  const fillResult: FillRunResult = {
    preview: makePreview({ totalSegments: 4, readyToFill: 2 }),
    filledCount: 2,
    filledDomIds: ['row-1', 'row-2'],
    stoppedByAutoStop: true,
    autoStopAfterFilledCount: 2
  };
  const harness = createHarness({
    state: makeRuntimeState({
      translationEntries: [ENTRY],
      previewResult: makePreview({ readyToFill: 4 })
    }),
    tab: {
      id: 88,
      url: 'https://memoq.example.net/memoqweb/editor/projects/p1/docs/d1'
    },
    responses: [{ ok: true, data: fillResult } satisfies ApiResponse<FillRunResult>]
  });

  const response = await harness.handler.handle({
    type: 'RUN_FILL',
    payload: {
      fillOptions: {
        autoStopAfterFilledCount: 2,
        validatePlaceholders: true
      }
    }
  });

  assert.equal(response.ok, true);
  const message = harness.tabMessages[0]?.message as Extract<
    ContentRequest,
    { type: 'CONTENT_FILL' }
  >;
  assert.equal(message.type, 'CONTENT_FILL');
  assert.equal(message.payload.plannedFillCount, 4);
  assert.equal(message.payload.maxPasses, 1200);
  assert.equal(message.payload.maxSegments, 10000);
  assert.equal(message.payload.scanFromTop, true);
  assert.equal(harness.getState().runState.phase, 'idle');
  assert.equal(harness.getState().runState.filledCount, 2);
  assert.equal(harness.getState().runState.scannedCount, 4);
  assert.equal(
    harness.getState().runState.message,
    'Filled 2 segment(s) and auto-stopped at 2.'
  );
});

test('BackgroundRequestHandler keeps non-memoQ Fill on default scan limits', async () => {
  const fillResult: FillRunResult = {
    preview: makePreview(),
    filledCount: 1,
    filledDomIds: ['segment-1'],
    stoppedByAutoStop: false,
    autoStopAfterFilledCount: null
  };
  const harness = createHarness({
    state: makeRuntimeState({
      translationEntries: [ENTRY],
      previewResult: makePreview()
    }),
    tab: {
      id: 77,
      url: 'https://gentrans.genplus.cn/#/olEditor'
    },
    responses: [{ ok: true, data: fillResult } satisfies ApiResponse<FillRunResult>]
  });

  await harness.handler.handle({
    type: 'RUN_FILL',
    payload: {
      fillOptions: {
        autoStopAfterFilledCount: null,
        validatePlaceholders: true
      }
    }
  });

  const message = harness.tabMessages[0]?.message as Extract<
    ContentRequest,
    { type: 'CONTENT_FILL' }
  >;
  assert.equal(message.type, 'CONTENT_FILL');
  assert.equal(message.payload.maxPasses, undefined);
  assert.equal(message.payload.maxSegments, undefined);
  assert.equal(message.payload.scanFromTop, undefined);
});

test('BackgroundRequestHandler exports all scanned sources with a stable date', async () => {
  const harness = createHarness({
    responses: [{ ok: true, data: [SEGMENT] } satisfies ApiResponse<PageSegment[]>]
  });

  const response = await harness.handler.handle({ type: 'EXPORT_SOURCES' });

  assert.equal(response.ok, true);
  const result = response.ok
    ? (response.data as {
        fileName: string;
        bytes: number[];
        segmentCount: number;
      })
    : null;
  assert.equal(result?.fileName, 'memoq-sources-2026-07-15.xlsx');
  assert.equal(result?.segmentCount, 1);
  assert.equal(Boolean(result?.bytes.length), true);
  const request = harness.tabMessages[0]?.message as Extract<
    ContentRequest,
    { type: 'CONTENT_SCAN' }
  >;
  assert.equal(request.payload.maxPasses, 1200);
  assert.equal(request.payload.maxSegments, 10000);
  assert.equal(request.payload.scanFromTop, true);
});

test('BackgroundRequestHandler finalizes failed Preview runs as errors', async () => {
  const harness = createHarness({
    state: makeRuntimeState({ translationEntries: [ENTRY] }),
    responses: [
      { ok: false, error: 'Editor scan failed.' } satisfies ApiResponse<PageSegment[]>
    ]
  });

  const error = await captureError(() =>
    harness.handler.handle({ type: 'RUN_PREVIEW' })
  );

  assert.equal(
    error instanceof Error ? error.message : null,
    'Editor scan failed.'
  );
  assert.equal(harness.getState().runState.phase, 'idle');
  assert.equal(harness.getState().runState.statusKind, 'error');
  assert.equal(harness.getState().runState.message, 'Editor scan failed.');
});

test('BackgroundRequestHandler marks Stop before messaging the stored frame', async () => {
  const harness = createHarness({
    state: makeRuntimeState({
      runState: {
        ...DEFAULT_RUN_STATE,
        runId: 'run-1',
        kind: 'fill',
        phase: 'running',
        tabId: 91,
        frameId: 6,
        startedAt: '2026-07-15T00:00:00.000Z',
        lastUpdatedAt: '2026-07-15T00:00:00.000Z'
      }
    }),
    responses: [{ ok: true, data: null } satisfies ApiResponse<null>]
  });

  const response = await harness.handler.handle({ type: 'STOP_RUN' });

  assert.equal(response.ok, true);
  assert.deepEqual(harness.events.slice(0, 3), [
    'read-state',
    'write-state:stopping',
    'send:CONTENT_STOP'
  ]);
  assert.equal(harness.getState().runState.phase, 'stopping');
  assert.equal(
    harness.getState().runState.lastUpdatedAt,
    '2026-07-15T12:34:56.000Z'
  );
  assert.deepEqual(harness.tabMessages[0], {
    tabId: 91,
    message: { type: 'CONTENT_STOP' },
    options: { frameId: 6 }
  });
});

test('BackgroundRequestHandler keeps debugger attachments alive and ignores stale progress', async () => {
  const activeState = makeRuntimeState({
    runState: {
      ...DEFAULT_RUN_STATE,
      runId: 'run-current',
      kind: 'fill',
      phase: 'running',
      tabId: 42,
      startedAt: '2026-07-15T00:00:00.000Z',
      lastUpdatedAt: '2026-07-15T00:00:00.000Z'
    }
  });
  const harness = createHarness({ state: activeState });

  await harness.handler.handle(
    {
      type: 'REPORT_RUN_PROGRESS',
      payload: { runId: 'run-stale', filledCount: 8 }
    },
    { tab: { id: 42 } }
  );
  assert.deepEqual(harness.keepAliveCalls, [42]);
  assert.deepEqual(harness.writes, []);

  await harness.handler.handle(
    {
      type: 'REPORT_RUN_PROGRESS',
      payload: { runId: 'run-current', scannedCount: 10, filledCount: 3 }
    },
    { tab: { id: 42 } }
  );
  assert.deepEqual(harness.keepAliveCalls, [42, 42]);
  assert.equal(harness.getState().runState.scannedCount, 10);
  assert.equal(harness.getState().runState.filledCount, 3);
});

test('BackgroundRequestHandler forwards trusted input only for sender tabs', async () => {
  const harness = createHarness();

  await harness.handler.handle(
    {
      type: 'DEBUGGER_WRITE_TEXT',
      payload: { x: 12, y: 34, text: 'Text' }
    },
    { tab: { id: 55 } }
  );
  await harness.handler.handle(
    {
      type: 'DEBUGGER_INPUT_SEQUENCE',
      payload: {
        x: 20,
        y: 40,
        operations: [{ type: 'text', text: 'Before' }]
      }
    },
    { tab: { id: 55 } }
  );
  await harness.handler.handle(
    { type: 'MEMOQ_DEBUGGER_PREPARE' },
    { tab: { id: 55 } }
  );

  assert.deepEqual(harness.writeTextCalls, [
    { tabId: 55, x: 12, y: 34, text: 'Text' }
  ]);
  assert.deepEqual(harness.sequenceCalls, [
    {
      tabId: 55,
      x: 20,
      y: 40,
      operations: [{ type: 'text', text: 'Before' }]
    }
  ]);
  assert.deepEqual(harness.prepareCalls, [55]);

  const error = await captureError(() =>
    harness.handler.handle({
      type: 'DEBUGGER_WRITE_TEXT',
      payload: { x: 1, y: 2, text: 'Missing sender' }
    })
  );
  assert.equal(
    error instanceof Error ? error.message : null,
    'Trusted write requires a sender tab.'
  );
});

test('BackgroundRequestHandler rejects unsupported tabs before script injection', async () => {
  const harness = createHarness({
    tab: { id: 9, url: 'https://example.com/' }
  });

  const error = await captureError(() =>
    harness.handler.handle({ type: 'EXPORT_SOURCES' })
  );

  assert.equal(
    error instanceof Error ? error.message : null,
    'Open a Phrase, memoQ, or GientTrans editor tab before running Preview, Fill, or Export.'
  );
  assert.deepEqual(harness.scriptCalls, []);
  assert.equal(harness.infoLogs[0]?.message, 'Rejected active tab for CAT run.');
});
