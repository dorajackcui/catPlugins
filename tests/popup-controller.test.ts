import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PopupController,
  type PopupFile,
  type PopupViewHandlers,
  type PopupViewPort
} from '../popup/controller.ts';
import { DEFAULT_FILL_OPTIONS } from '../domain/fill-options.ts';
import { DEFAULT_RUN_STATE } from '../domain/run-state.ts';
import type {
  BackgroundRequest,
  ExportSourcesResult,
  FillOptions,
  FillRunResult,
  PopupState,
  PreviewResult,
  RunState,
  StatusKind
} from '../shared/types.ts';

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

function makePopupState(overrides: Partial<PopupState> = {}): PopupState {
  return {
    uploadMeta: null,
    previewResult: null,
    fillOptions: { ...DEFAULT_FILL_OPTIONS },
    runState: { ...DEFAULT_RUN_STATE },
    ...overrides
  };
}

class FakePopupView implements PopupViewPort {
  handlers: PopupViewHandlers | null = null;
  readonly busyValues: boolean[] = [];
  readonly stoppingValues: boolean[] = [];
  readonly statuses: Array<{ message: string; kind: StatusKind }> = [];
  readonly popupStates: PopupState[] = [];
  readonly renderedFillOptions: Array<FillOptions | null | undefined> = [];
  readonly downloads: ExportSourcesResult[] = [];
  clearFileSelectionCalls = 0;
  fillOptions: FillOptions = {
    autoStopAfterFilledCount: 5,
    validatePlaceholders: true
  };

  bind(handlers: PopupViewHandlers): void {
    this.handlers = handlers;
  }

  setBusy(busy: boolean): void {
    this.busyValues.push(busy);
  }

  setStopping(stopping: boolean): void {
    this.stoppingValues.push(stopping);
  }

  renderStatus(message: string, kind: StatusKind = 'default'): void {
    this.statuses.push({ message, kind });
  }

  renderFileInfo(popupState: PopupState): void {
    this.popupStates.push(popupState);
  }

  renderFillOptions(fillOptions?: FillOptions | null): void {
    this.renderedFillOptions.push(fillOptions);
  }

  readFillOptions(): FillOptions {
    return { ...this.fillOptions };
  }

  clearFileSelection(): void {
    this.clearFileSelectionCalls += 1;
  }

  downloadExportFile(result: ExportSourcesResult): void {
    this.downloads.push(result);
  }
}

function createHarness(
  scriptedResponses: Array<unknown | Error> = []
) {
  const view = new FakePopupView();
  const responses = [...scriptedResponses];
  const messages: BackgroundRequest[] = [];
  const intervalCalls: Array<{ timerId: number; delayMs: number }> = [];
  const intervalCallbacks = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  let nextTimerId = 1;

  const controller = new PopupController({
    view,
    async sendMessage<T>(message: BackgroundRequest): Promise<T> {
      messages.push(message);
      if (!responses.length) {
        throw new Error(`No scripted response for ${message.type}.`);
      }
      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }
      return response as T;
    },
    setInterval(callback, delayMs) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      intervalCalls.push({ timerId, delayMs });
      intervalCallbacks.set(timerId, callback);
      return timerId;
    },
    clearInterval(timerId) {
      clearedTimers.push(timerId);
      intervalCallbacks.delete(timerId);
    }
  });

  return {
    controller,
    view,
    messages,
    intervalCalls,
    intervalCallbacks,
    clearedTimers
  };
}

test('PopupController refreshes all views and manages the active-run timer', async () => {
  const activeRunState: RunState = {
    ...DEFAULT_RUN_STATE,
    runId: 'run-1',
    kind: 'fill',
    phase: 'running',
    tabId: 42,
    plannedFillCount: 5,
    filledCount: 2,
    startedAt: '2026-07-15T00:00:00.000Z',
    lastUpdatedAt: '2026-07-15T00:00:00.000Z'
  };
  const preview = makePreview();
  const activeState = makePopupState({
    runState: activeRunState,
    previewResult: preview
  });
  const idleState = makePopupState();
  const harness = createHarness([activeState, idleState]);

  await harness.controller.refreshState();

  assert.deepEqual(harness.view.busyValues, [true]);
  assert.deepEqual(harness.view.stoppingValues, [false]);
  assert.deepEqual(harness.intervalCalls, [{ timerId: 1, delayMs: 1000 }]);
  assert.equal(harness.view.popupStates[0], activeState);
  assert.equal(harness.view.renderedFillOptions[0], activeState.fillOptions);

  await harness.controller.refreshState();

  assert.deepEqual(harness.view.busyValues, [true, false]);
  assert.deepEqual(harness.clearedTimers, [1]);
  assert.deepEqual(harness.messages, [
    { type: 'GET_STATE' },
    { type: 'GET_STATE' }
  ]);
});

test('PopupController uploads bytes, refreshes state, and clears file selection', async () => {
  const refreshedState = makePopupState({
    uploadMeta: {
      fileName: 'translations.xlsx',
      entryCount: 3,
      uploadedAt: '2026-07-15T00:00:00.000Z',
      sheetName: 'Sheet1'
    }
  });
  const harness = createHarness([{ entryCount: 3 }, refreshedState]);
  const file: PopupFile = {
    name: 'translations.xlsx',
    async arrayBuffer() {
      return Uint8Array.from([1, 2, 255]).buffer;
    }
  };

  await harness.controller.handleUpload(file);

  assert.deepEqual(harness.messages, [
    {
      type: 'PARSE_EXCEL',
      payload: {
        fileName: 'translations.xlsx',
        bytes: [1, 2, 255]
      }
    },
    { type: 'GET_STATE' }
  ]);
  assert.equal(harness.view.busyValues[0], true);
  assert.equal(harness.view.busyValues.at(-1), false);
  assert.equal(harness.view.clearFileSelectionCalls, 1);
  assert.equal(
    harness.view.statuses.some(
      ({ message }) =>
        message === 'Loaded 3 translation rows from translations.xlsx.'
    ),
    true
  );
});

test('PopupController downloads Export results before refreshing state', async () => {
  const exportResult: ExportSourcesResult = {
    fileName: 'memoq-sources.xlsx',
    bytes: [1, 2, 3],
    segmentCount: 12
  };
  const harness = createHarness([exportResult, makePopupState()]);

  await harness.controller.handleExportSources();

  assert.deepEqual(harness.messages, [
    { type: 'EXPORT_SOURCES' },
    { type: 'GET_STATE' }
  ]);
  assert.deepEqual(harness.view.downloads, [exportResult]);
  assert.equal(
    harness.view.statuses.some(
      ({ message }) => message === 'Exported 12 source segment(s).'
    ),
    true
  );
});

test('PopupController renders Fill stop reasons as errors', async () => {
  const result: FillRunResult = {
    preview: makePreview(),
    filledCount: 2,
    filledDomIds: ['one', 'two'],
    stoppedByAutoStop: false,
    autoStopAfterFilledCount: null,
    stopReason: 'Stopped at Phrase segment row-3.'
  };
  const harness = createHarness([result, makePopupState()]);

  await harness.controller.handleFill();

  assert.deepEqual(harness.messages[0], {
    type: 'RUN_FILL',
    payload: { fillOptions: harness.view.fillOptions }
  });
  assert.equal(
    harness.view.statuses.some(
      ({ message, kind }) =>
        message === result.stopReason && kind === 'error'
    ),
    true
  );
});

test('PopupController maps user-stopped operations back to a default status', async () => {
  const harness = createHarness([
    new Error('Operation stopped by user.'),
    makePopupState()
  ]);

  await harness.controller.handleFill();

  assert.equal(
    harness.view.statuses.some(
      ({ message, kind }) => message === 'Stopped.' && kind === 'default'
    ),
    true
  );
});

test('PopupController only sends Stop while an active run is stoppable', async () => {
  const activeState = makePopupState({
    runState: {
      ...DEFAULT_RUN_STATE,
      runId: 'run-1',
      kind: 'fill',
      phase: 'running',
      tabId: 42,
      startedAt: '2026-07-15T00:00:00.000Z',
      lastUpdatedAt: '2026-07-15T00:00:00.000Z'
    }
  });
  const harness = createHarness([activeState, null]);

  await harness.controller.handleStop();
  assert.deepEqual(harness.messages, []);

  await harness.controller.refreshState();
  await harness.controller.handleStop();
  await harness.controller.handleStop();

  assert.deepEqual(harness.messages, [
    { type: 'GET_STATE' },
    { type: 'STOP_RUN' }
  ]);
  assert.equal(
    harness.view.statuses.some(
      ({ message }) => message === 'Stopping current run...'
    ),
    true
  );
});

test('PopupController persists the view fill options unchanged', async () => {
  const harness = createHarness([{ ...DEFAULT_FILL_OPTIONS }]);
  harness.view.fillOptions = {
    autoStopAfterFilledCount: 25,
    validatePlaceholders: false
  };

  await harness.controller.persistFillOptions();

  assert.deepEqual(harness.messages, [
    {
      type: 'SET_FILL_OPTIONS',
      payload: { fillOptions: harness.view.fillOptions }
    }
  ]);
});
