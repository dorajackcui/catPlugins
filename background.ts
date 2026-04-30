import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import {
  getEditorPlatformForUrl,
  getPlatformDisplayName,
  isMemsourceEditorFrameUrl,
  isSupportedEditorUrl
} from './editor-platform.ts';
import { parseExcelBuffer } from './excel.ts';
import { formatFillCompletionMessage } from './fill-result.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { normalizePlannedFillCount } from './fill-throttle.ts';
import { buildPreview } from './matcher.ts';
import { logMemoqDiagnostic } from './memoq-debug.ts';
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
const STOP_ERROR_MESSAGE = 'Operation stopped by user.';

function logMemoqBackground(
  stage: Parameters<typeof logMemoqDiagnostic>[1],
  message: string,
  details?: Record<string, unknown>,
  options?: {
    level?: Parameters<typeof logMemoqDiagnostic>[4];
    runId?: string | null;
  }
): void {
  logMemoqDiagnostic(
    {
      scope: 'background',
      runId: options?.runId
    },
    stage,
    message,
    details,
    options?.level
  );
}

async function ensureEditorTab(): Promise<{
  id: number;
  url?: string;
  frameId?: number;
  platform: 'memoq' | 'phrase';
}> {
  const tab = await queryActiveTab();
  const platform = getEditorPlatformForUrl(tab.url);

  if (!platform || !isSupportedEditorUrl(tab.url)) {
    throw new Error(
      `Open a supported Phrase or memoQ editor tab before running Preview or Fill. Current URL: ${tab.url ?? 'unknown'}.`
    );
  }

  if (platform === 'memoq') {
    logMemoqBackground('tab-check', 'Detected memoQ editor tab.', {
      tabId: tab.id,
      url: tab.url
    });
  }

  try {
    await executeScript(tab.id, ['content-script.js'], { allFrames: true });
  } catch (error) {
    if (platform === 'memoq') {
      logMemoqBackground(
        'script-inject',
        'Failed to inject content script into memoQ.',
        {
          tabId: tab.id,
          url: tab.url,
          error: error instanceof Error ? error.message : String(error)
        },
        {
          level: 'error'
        }
      );
    }

    throw new Error(
      `Failed to inject the ${getPlatformDisplayName(platform)} helper script. ${error instanceof Error ? error.message : 'Unknown scripting error.'}`
    );
  }

  let editorFrame:
    | {
        frameId: number;
        parentFrameId: number;
        url?: string;
      }
    | undefined;

  if (platform === 'phrase') {
    const frames = await getAllFrames(tab.id);
    editorFrame = frames.find((frame) => isMemsourceEditorFrameUrl(frame.url));
  } else {
    logMemoqBackground('frame-resolve', 'memoQ uses the main frame.', {
      tabId: tab.id,
      url: tab.url
    });
  }

  return {
    ...tab,
    frameId: editorFrame?.frameId,
    platform
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
    const tab = await ensureEditorTab();
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

async function handleMessage(request: BackgroundRequest): Promise<ApiResponse<unknown>> {
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

      const tab = await ensureEditorTab();
      const runState = createRunningRunState('preview', tab);
      await writeRuntimeState({
        fillOptions,
        runState
      });

      try {
        if (tab.platform === 'memoq') {
          logMemoqBackground(
            'content-request',
            'Sending preview request to memoQ content script.',
            {
              tabId: tab.id,
              frameId: tab.frameId ?? null,
              url: tab.url
            },
            {
              runId: runState.runId
            }
          );
        }

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

        const preview = buildPreview(state.translationEntries, response.data, fillOptions);
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
        if (tab.platform === 'memoq') {
          logMemoqBackground(
            'content-request',
            'memoQ preview failed.',
            {
              tabId: tab.id,
              frameId: tab.frameId ?? null,
              url: tab.url,
              error: error instanceof Error ? error.message : String(error)
            },
            {
              level: 'error',
              runId: runState.runId
            }
          );
        }

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

      const tab = await ensureEditorTab();
      const runState = createRunningRunState('fill', tab, {
        plannedFillCount
      });
      await writeRuntimeState({
        fillOptions,
        runState
      });

      try {
        if (tab.platform === 'memoq') {
          logMemoqBackground(
            'content-request',
            'Sending fill request to memoQ content script.',
            {
              tabId: tab.id,
              frameId: tab.frameId ?? null,
              url: tab.url,
              plannedFillCount
            },
            {
              runId: runState.runId
            }
          );
        }

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

        const result = response.data;

        await writeRuntimeState({
          previewResult: result.preview,
          fillOptions
        });
        await finalizeRunState(runState.runId ?? '', {
          message: formatFillCompletionMessage(result),
          filledCount: result.filledCount,
          scannedCount: result.preview.totalSegments,
          plannedFillCount
        });
        return { ok: true, data: result };
      } catch (error) {
        if (tab.platform === 'memoq') {
          logMemoqBackground(
            'content-request',
            'memoQ fill failed.',
            {
              tabId: tab.id,
              frameId: tab.frameId ?? null,
              url: tab.url,
              plannedFillCount,
              error: error instanceof Error ? error.message : String(error)
            },
            {
              level: 'error',
              runId: runState.runId
            }
          );
        }

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

    default: {
      throw new Error('Unsupported request.');
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    _sender: unknown,
    sendResponse: (response: ApiResponse<unknown>) => void
  ) => {
    void (async () => {
      try {
        sendResponse(await handleMessage(request));
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
