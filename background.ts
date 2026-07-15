import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import { DebuggerInputController } from './debugger-input.ts';
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
import {
  createFinishedRunState,
  createRunningRunState,
  DEFAULT_RUN_STATE,
  isRunActive,
  mergeRunProgress,
  normalizeRunState
} from './run-state.ts';
import { readRuntimeState, writeRuntimeState } from './storage.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  ExportSourcesResult,
  FillRunResult,
  PageSegment,
  PopupState,
  RunState,
  StatusKind
} from './types.ts';

const STOP_ERROR_MESSAGE = 'Operation stopped by user.';
const EXPORT_SCAN_MAX_PASSES = 1200;
const EXPORT_SCAN_MAX_SEGMENTS = 10000;
const DEBUG_PREFIX = '[Phrase Bulk Fill]';

const debuggerInput = new DebuggerInputController(chrome);

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
      debuggerInput.keepAlive(sender?.tab?.id);
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

      await debuggerInput.writeText(
        tabId,
        request.payload.x,
        request.payload.y,
        request.payload.text
      );
      return { ok: true, data: null };
    }

    case 'DEBUGGER_INPUT_SEQUENCE': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('Trusted input sequence requires a sender tab.');
      }

      await debuggerInput.runSequence(
        tabId,
        request.payload.x,
        request.payload.y,
        request.payload.operations
      );
      return { ok: true, data: null };
    }

    case 'MEMOQ_DEBUGGER_PREPARE': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('memoQ trusted input requires a sender tab.');
      }

      await debuggerInput.prepare(tabId);
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
