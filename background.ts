import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import { parseExcelBuffer } from './excel.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { normalizePlannedFillCount } from './fill-throttle.ts';
import { applyMemoqPreviewCorrection, buildPreview } from './matcher.ts';
import { DEFAULT_RUN_STATE, isRunActive, normalizeRunState } from './run-state.ts';
import { readRuntimeState, writeRuntimeState } from './storage.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  FillRunResult,
  PageSegment,
  PopupState,
  RunKind,
  RunState,
  StatusKind
} from './types.ts';

const MEMOQ_URL_RE = /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/webpm\/webtrans\//;
const MEMSOURCE_JOB_URL_RE =
  /^https:\/\/cloud\.memsource\.com\/web\/job\/[^/]+\/translate(?:[/?#]|$)/;
const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;
const STOP_ERROR_MESSAGE = 'Operation stopped by user.';
const CHROME_DEBUGGER_PROTOCOL_VERSION = '1.3';

interface RuntimeMessageSender {
  tab?: {
    id?: number;
  };
}

function isPhraseEditorUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('https://app.phrase.com/editor/') ||
    MEMSOURCE_JOB_URL_RE.test(url) ||
    MEMOQ_URL_RE.test(url)
  );
}

function isMemoqUrl(url?: string): boolean {
  return Boolean(url && MEMOQ_URL_RE.test(url));
}

function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
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

  if (!isPhraseEditorUrl(tab.url)) {
    throw new Error('Open a Phrase editor tab before running Preview or Fill.');
  }

  await executeScript(tab.id, ['content-script.js'], { allFrames: true });

  const frames = await getAllFrames(tab.id);
  const editorFrame = frames.find((frame) => isMemsourceEditorFrameUrl(frame.url));

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

  const activeTaskLabel = state.runState.kind === 'preview' ? 'Preview' : 'Fill';
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

async function withAttachedDebugger(
  tabId: number,
  callback: (target: { tabId: number }) => Promise<void>
): Promise<void> {
  const target = { tabId };
  let attached = false;

  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(target, CHROME_DEBUGGER_PROTOCOL_VERSION, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        attached = true;
        resolve();
      });
    });

    await callback(target);
  } finally {
    if (attached) {
      await new Promise<void>((resolve) => {
        chrome.debugger.detach(target, () => {
          resolve();
        });
      });
    }
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

async function dispatchTrustedTabClick(tabId: number, x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Invalid memoQ click coordinates.');
  }

  await withAttachedDebugger(tabId, async (target) => {
    await dispatchTrustedMemoqClick(target, x, y);
  });
}

async function dispatchTrustedMemoqWrite(
  tabId: number,
  x: number,
  y: number,
  text: string
): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
    throw new Error('Invalid memoQ trusted write payload.');
  }

  await withAttachedDebugger(tabId, async (target) => {
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
  });
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
            plannedFillCount
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
            result.stoppedByAutoStop && result.autoStopAfterFilledCount !== null
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

    case 'MEMOQ_DEBUGGER_WRITE_TEXT': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('memoQ trusted write requires a sender tab.');
      }

      await dispatchTrustedMemoqWrite(
        tabId,
        request.payload.x,
        request.payload.y,
        request.payload.text
      );
      return { ok: true, data: null };
    }

    case 'MEMOQ_DEBUGGER_CLICK': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('memoQ trusted click requires a sender tab.');
      }

      await dispatchTrustedTabClick(tabId, request.payload.x, request.payload.y);
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
