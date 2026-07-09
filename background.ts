import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import {
  isGientTransUrl,
  isMemsourceEditorFrameUrl,
  isMemoqUrl,
  isSupportedEditorUrl
} from './editor-url.ts';
import { buildSourceExportWorkbook, parseExcelBuffer } from './excel.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { normalizePlannedFillCount } from './fill-throttle.ts';
import { applyMemoqPreviewCorrection, buildPreview } from './matcher.ts';
import { DEFAULT_RUN_STATE, isRunActive, normalizeRunState } from './run-state.ts';
import { readRuntimeState, writeRuntimeState } from './storage.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  ExportSourcesResult,
  FillRunResult,
  PageSegment,
  PopupState,
  RunKind,
  RunState,
  StatusKind
} from './types.ts';

const STOP_ERROR_MESSAGE = 'Operation stopped by user.';
const EXPORT_SCAN_MAX_PASSES = 1200;
const EXPORT_SCAN_MAX_SEGMENTS = 10000;
const CHROME_DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUG_PREFIX = '[Phrase Bulk Fill]';

interface RuntimeMessageSender {
  tab?: {
    id?: number;
  };
}

function finalizePreviewForTab<T extends { preview: ReturnType<typeof applyMemoqPreviewCorrection> }>(
  url: string | undefined,
  result: T
): T {
  if (!isMemoqUrl(url)) {
    return result;
  }

  return {
    ...result,
    preview: applyMemoqPreviewCorrection(result.preview)
  };
}

function buildPreviewForTab(
  url: string | undefined,
  preview: ReturnType<typeof buildPreview>
): ReturnType<typeof buildPreview> {
  return isMemoqUrl(url) ? applyMemoqPreviewCorrection(preview) : preview;
}

async function ensurePhraseTab(): Promise<{
  id: number;
  url?: string;
  frameId?: number;
}> {
  const tab = await queryActiveTab();

  if (!isSupportedEditorUrl(tab.url)) {
    console.info(DEBUG_PREFIX, 'Rejected active tab for CAT run.', { url: tab.url });
    throw new Error('Open a Phrase, memoQ, or GientTrans editor tab before running Preview, Fill, or Export.');
  }

  await executeScript(tab.id, ['content-script.js'], { allFrames: true });

  const frames = await getAllFrames(tab.id);
  const editorFrame = frames.find((frame) => isMemsourceEditorFrameUrl(frame.url));
  console.info(DEBUG_PREFIX, 'Prepared editor tab for CAT run.', {
    tabId: tab.id,
    url: tab.url,
    platform: isGientTransUrl(tab.url) ? 'gientrans' : isMemoqUrl(tab.url) ? 'memoq' : 'phrase',
    frameId: editorFrame?.frameId ?? null
  });

  return {
    ...tab,
    frameId: editorFrame?.frameId
  };
}

function createRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createRunningRunState(
  kind: RunKind,
  target: { id: number; frameId?: number },
  options?: {
    plannedFillCount?: number | null;
  }
): RunState {
  const now = new Date().toISOString();

  return normalizeRunState({
    runId: createRunId(),
    kind,
    phase: 'running',
    statusKind: 'default',
    startedAt: now,
    lastUpdatedAt: now,
    tabId: target.id,
    frameId: target.frameId ?? null,
    plannedFillCount: options?.plannedFillCount ?? null,
    scannedCount: 0,
    filledCount: 0,
    message: ''
  });
}

function createFinishedRunState(
  currentRunState: RunState,
  options: {
    message: string;
    statusKind?: StatusKind;
    scannedCount?: number;
    filledCount?: number;
    plannedFillCount?: number | null;
  }
): RunState {
  return normalizeRunState({
    ...DEFAULT_RUN_STATE,
    startedAt: currentRunState.startedAt,
    lastUpdatedAt: new Date().toISOString(),
    scannedCount: options.scannedCount ?? currentRunState.scannedCount,
    filledCount: options.filledCount ?? currentRunState.filledCount,
    plannedFillCount:
      options.plannedFillCount === undefined
        ? currentRunState.plannedFillCount
        : options.plannedFillCount,
    message: options.message,
    statusKind: options.statusKind ?? 'default'
  });
}

function mergeRunProgress(
  currentRunState: RunState,
  payload: Extract<BackgroundRequest, { type: 'REPORT_RUN_PROGRESS' }>['payload']
): RunState {
  return normalizeRunState({
    ...currentRunState,
    phase:
      currentRunState.phase === 'stopping'
        ? 'stopping'
        : payload.phase ?? currentRunState.phase,
    lastUpdatedAt: new Date().toISOString(),
    scannedCount:
      typeof payload.scannedCount === 'number'
        ? Math.max(currentRunState.scannedCount, Math.floor(payload.scannedCount))
        : currentRunState.scannedCount,
    filledCount:
      typeof payload.filledCount === 'number'
        ? Math.max(currentRunState.filledCount, Math.floor(payload.filledCount))
        : currentRunState.filledCount,
    plannedFillCount:
      payload.plannedFillCount === undefined
        ? currentRunState.plannedFillCount
        : normalizePlannedFillCount(payload.plannedFillCount),
    message:
      typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : currentRunState.message
  });
}

async function finalizeRunState(
  runId: string,
  options: {
    message: string;
    statusKind?: StatusKind;
    scannedCount?: number;
    filledCount?: number;
    plannedFillCount?: number | null;
  }
): Promise<void> {
  const latestState = await readRuntimeState();
  const currentRunState =
    latestState.runState.runId === runId ? latestState.runState : DEFAULT_RUN_STATE;

  await writeRuntimeState({
    runState: createFinishedRunState(currentRunState, options)
  });
}

async function assertNoActiveRun(action: string): Promise<void> {
  const state = await readRuntimeState();

  if (!isRunActive(state.runState)) {
    return;
  }

  const activeTaskLabel =
    state.runState.kind === 'preview'
      ? 'Preview'
      : state.runState.kind === 'export'
        ? 'Export'
        : 'Fill';
  throw new Error(`${activeTaskLabel} is already running. Stop it before ${action}.`);
}

async function stopActiveRun(runState?: RunState): Promise<void> {
  const activeRunState = runState ?? (await readRuntimeState()).runState;
  const tabId = activeRunState.tabId;

  if (typeof tabId !== 'number') {
    const tab = await ensurePhraseTab();
    await sendTabMessage<ContentRequest, ApiResponse<null>>(
      tab.id,
      { type: 'CONTENT_STOP' },
      tab.frameId ? { frameId: tab.frameId } : undefined
    );
    return;
  }

  await sendTabMessage<ContentRequest, ApiResponse<null>>(
    tabId,
    { type: 'CONTENT_STOP' },
    typeof activeRunState.frameId === 'number'
      ? { frameId: activeRunState.frameId }
      : undefined
  );
}

async function getPopupState(): Promise<PopupState> {
  const state = await readRuntimeState();

  return {
    uploadMeta: state.uploadMeta,
    previewResult: state.previewResult,
    fillOptions: state.fillOptions,
    runState: state.runState
  };
}

function createSourceExportFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `memoq-sources-${date}.xlsx`;
}

// Attaching/detaching the debugger per click makes the "extension is
// debugging this browser" infobar pop in and out around every trusted click.
// Each toggle resizes the page, and memoQ's virtualized grid re-lays out
// right between coordinate measurement and the click — so the click lands on
// the wrong row. Keep one attachment alive across the run: every debugger
// message AND every run-progress report resets the idle timer, so the
// attachment only drops once the run has actually gone quiet.
const DEBUGGER_IDLE_DETACH_MS = 30000;
const DEBUGGER_FRESH_ATTACH_SETTLE_MS = 600;

const debuggerAttachments = new Map<number, { idleTimer: ReturnType<typeof setTimeout> | null }>();
// attach/detach must never overlap for a tab: an attach issued while the
// idle detach is still in flight fails with "another debugger is already
// attached". Chain every transition through this per-tab promise.
const debuggerTransitions = new Map<number, Promise<void>>();

chrome.debugger.onDetach.addListener((source: { tabId?: number }) => {
  if (typeof source.tabId !== 'number') {
    return;
  }

  const attachment = debuggerAttachments.get(source.tabId);
  if (attachment?.idleTimer !== null && attachment?.idleTimer !== undefined) {
    clearTimeout(attachment.idleTimer);
  }
  debuggerAttachments.delete(source.tabId);
});

function enqueueDebuggerTransition(tabId: number, operation: () => Promise<void>): Promise<void> {
  const previous = debuggerTransitions.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  debuggerTransitions.set(
    tabId,
    next.catch(() => undefined)
  );
  return next;
}

function scheduleDebuggerIdleDetach(tabId: number): void {
  const attachment = debuggerAttachments.get(tabId);
  if (!attachment) {
    return;
  }

  if (attachment.idleTimer !== null) {
    clearTimeout(attachment.idleTimer);
  }

  attachment.idleTimer = setTimeout(() => {
    void enqueueDebuggerTransition(tabId, async () => {
      if (!debuggerAttachments.has(tabId)) {
        return;
      }

      debuggerAttachments.delete(tabId);
      await new Promise<void>((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    });
  }, DEBUGGER_IDLE_DETACH_MS);
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  await enqueueDebuggerTransition(tabId, async () => {
    if (debuggerAttachments.has(tabId)) {
      scheduleDebuggerIdleDetach(tabId);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, CHROME_DEBUGGER_PROTOCOL_VERSION, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });

    debuggerAttachments.set(tabId, { idleTimer: null });
    scheduleDebuggerIdleDetach(tabId);

    // The infobar shown by a fresh attachment resizes the page; wait for the
    // editor layout to settle before callers measure coordinates.
    await new Promise((resolve) => setTimeout(resolve, DEBUGGER_FRESH_ATTACH_SETTLE_MS));
  });
}

// Progress reports flow throughout scanning even when no segment needs a
// trusted click, so they keep the attachment alive across long stretches of
// skipped rows. Never attaches — only extends an existing attachment.
function keepDebuggerAttachmentAlive(tabId: number | undefined): void {
  if (typeof tabId === 'number' && debuggerAttachments.has(tabId)) {
    scheduleDebuggerIdleDetach(tabId);
  }
}

async function dispatchTrustedMemoqClick(
  target: { tabId: number },
  x: number,
  y: number
): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.sendCommand(
        target,
        'Input.dispatchMouseEvent',
        {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1
        },
        () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        }
      );
    });
  }
}

async function dispatchTrustedTextWrite(
  tabId: number,
  x: number,
  y: number,
  text: string
): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
    throw new Error('Invalid trusted write payload.');
  }

  await ensureDebuggerAttached(tabId);
  const target = { tabId };
  await dispatchTrustedMemoqClick(target, x, y);

  await new Promise<void>((resolve, reject) => {
    chrome.debugger.sendCommand(
      target,
      'Input.insertText',
      { text },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      }
    );
  });
  scheduleDebuggerIdleDetach(tabId);
}

async function handleMessage(
  request: BackgroundRequest,
  sender?: RuntimeMessageSender
): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'GET_STATE': {
      return { ok: true, data: await getPopupState() };
    }

    case 'PARSE_EXCEL': {
      await assertNoActiveRun('uploading a new Excel file');
      const parsed = parseExcelBuffer(
        Uint8Array.from(request.payload.bytes),
        request.payload.fileName
      );
      await writeRuntimeState({
        translationEntries: parsed.entries,
        uploadMeta: parsed.meta,
        previewResult: null
      });

      return {
        ok: true,
        data: {
          entryCount: parsed.entries.length
        }
      };
    }

    case 'RUN_PREVIEW': {
      const state = await readRuntimeState();
      if (!state.translationEntries.length) {
        throw new Error('Upload an Excel file before running Preview.');
      }
      if (isRunActive(state.runState)) {
        throw new Error('Another task is already running. Stop it before starting Preview.');
      }
      const fillOptions = normalizeFillOptions(request.payload?.fillOptions ?? state.fillOptions);

      const tab = await ensurePhraseTab();
      const runState = createRunningRunState('preview', tab);
      await writeRuntimeState({
        fillOptions,
        runState
      });

      try {
        const response = await sendTabMessage<
          ContentRequest,
          ApiResponse<PageSegment[]>
        >(
          tab.id,
          {
            type: 'CONTENT_SCAN',
            payload: {
              runId: runState.runId ?? ''
            }
          },
          tab.frameId ? { frameId: tab.frameId } : undefined
        );

        if (!response.ok) {
          throw new Error(response.error);
        }

        const preview = buildPreviewForTab(
          tab.url,
          buildPreview(state.translationEntries, response.data, fillOptions)
        );
        await writeRuntimeState({
          previewResult: preview,
          fillOptions
        });
        await finalizeRunState(runState.runId ?? '', {
          message: `Preview ready. ${preview.readyToFill} segment(s) can be filled.`,
          scannedCount: preview.totalSegments
        });
        return { ok: true, data: preview };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Preview failed.';
        await finalizeRunState(runState.runId ?? '', {
          message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
          statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error'
        });
        throw error;
      }
    }

    case 'EXPORT_SOURCES': {
      const state = await readRuntimeState();
      if (isRunActive(state.runState)) {
        throw new Error('Another task is already running. Stop it before starting Export.');
      }

      const tab = await ensurePhraseTab();
      const runState = createRunningRunState('export', tab);
      await writeRuntimeState({ runState });

      try {
        const response = await sendTabMessage<
          ContentRequest,
          ApiResponse<PageSegment[]>
        >(
          tab.id,
          {
            type: 'CONTENT_SCAN',
            payload: {
              runId: runState.runId ?? '',
              maxPasses: EXPORT_SCAN_MAX_PASSES,
              maxSegments: EXPORT_SCAN_MAX_SEGMENTS,
              scanFromTop: true
            }
          },
          tab.frameId ? { frameId: tab.frameId } : undefined
        );

        if (!response.ok) {
          throw new Error(response.error);
        }

        const workbookBytes = buildSourceExportWorkbook(response.data);
        const result: ExportSourcesResult = {
          fileName: createSourceExportFileName(),
          bytes: Array.from(workbookBytes),
          segmentCount: response.data.length
        };

        await finalizeRunState(runState.runId ?? '', {
          message: `Exported ${result.segmentCount} source segment(s).`,
          scannedCount: result.segmentCount
        });

        return { ok: true, data: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Export failed.';
        await finalizeRunState(runState.runId ?? '', {
          message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
          statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error'
        });
        throw error;
      }
    }

    case 'RUN_FILL': {
      const state = await readRuntimeState();
      if (!state.translationEntries.length) {
        throw new Error('Upload an Excel file before running Fill.');
      }
      if (isRunActive(state.runState)) {
        throw new Error('Another task is already running. Stop it before starting Fill.');
      }
      const fillOptions = normalizeFillOptions(request.payload?.fillOptions);
      const plannedFillCount = normalizePlannedFillCount(
        state.previewResult?.readyToFill ?? state.uploadMeta?.entryCount ?? state.translationEntries.length
      );

      const tab = await ensurePhraseTab();
      const runState = createRunningRunState('fill', tab, {
        plannedFillCount
      });
      await writeRuntimeState({
        fillOptions,
        runState
      });

      try {
        const response = await sendTabMessage<
          ContentRequest,
          ApiResponse<FillRunResult>
        >(tab.id, {
          type: 'CONTENT_FILL',
          payload: {
            runId: runState.runId ?? '',
            entries: state.translationEntries,
            fillOptions,
            plannedFillCount,
            ...(isMemoqUrl(tab.url)
              ? {
                  maxPasses: EXPORT_SCAN_MAX_PASSES,
                  maxSegments: EXPORT_SCAN_MAX_SEGMENTS,
                  scanFromTop: true
                }
              : {})
          }
        }, tab.frameId ? { frameId: tab.frameId } : undefined);

        if (!response.ok) {
          throw new Error(response.error);
        }

        const result = finalizePreviewForTab(tab.url, response.data);

        await writeRuntimeState({
          previewResult: result.preview,
          fillOptions
        });
        await finalizeRunState(runState.runId ?? '', {
          message:
            result.stopReason
              ? result.stopReason
              : result.stoppedByAutoStop && result.autoStopAfterFilledCount !== null
              ? `Filled ${result.filledCount} segment(s) and auto-stopped at ${result.autoStopAfterFilledCount}.`
              : `Filled ${result.filledCount} segment(s).`,
          filledCount: result.filledCount,
          scannedCount: result.preview.totalSegments,
          plannedFillCount
        });
        return { ok: true, data: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Fill failed.';
        await finalizeRunState(runState.runId ?? '', {
          message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
          statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error',
          plannedFillCount
        });
        throw error;
      }
    }

    case 'STOP_RUN': {
      const state = await readRuntimeState();
      if (!isRunActive(state.runState)) {
        return { ok: true, data: null };
      }

      await writeRuntimeState({
        runState: normalizeRunState({
          ...state.runState,
          phase: 'stopping',
          statusKind: 'default',
          lastUpdatedAt: new Date().toISOString()
        })
      });
      await stopActiveRun(state.runState);
      return { ok: true, data: null };
    }

    case 'SET_FILL_OPTIONS': {
      const fillOptions = normalizeFillOptions(request.payload?.fillOptions);
      await writeRuntimeState({ fillOptions });
      return { ok: true, data: fillOptions };
    }

    case 'REPORT_RUN_PROGRESS': {
      keepDebuggerAttachmentAlive(sender?.tab?.id);
      const state = await readRuntimeState();
      if (
        !isRunActive(state.runState) ||
        !state.runState.runId ||
        state.runState.runId !== request.payload.runId
      ) {
        return { ok: true, data: null };
      }

      await writeRuntimeState({
        runState: mergeRunProgress(state.runState, request.payload)
      });
      return { ok: true, data: null };
    }

    case 'MEMOQ_DEBUGGER_WRITE_TEXT':
    case 'DEBUGGER_WRITE_TEXT': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('Trusted write requires a sender tab.');
      }

      await dispatchTrustedTextWrite(
        tabId,
        request.payload.x,
        request.payload.y,
        request.payload.text
      );
      return { ok: true, data: null };
    }

    case 'MEMOQ_DEBUGGER_PREPARE': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('memoQ trusted input requires a sender tab.');
      }

      await ensureDebuggerAttached(tabId);
      return { ok: true, data: null };
    }

    default: {
      throw new Error('Unsupported request.');
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    sender: RuntimeMessageSender,
    sendResponse: (response: ApiResponse<unknown>) => void
  ) => {
    void (async () => {
      try {
        sendResponse(await handleMessage(request, sender));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown background error.'
        });
      }
    })();

    return true;
  }
);
