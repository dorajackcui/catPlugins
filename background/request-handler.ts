import { normalizeFillOptions } from '../domain/fill-options.ts';
import { normalizePlannedFillCount } from '../domain/fill-throttle.ts';
import { applyMemoqPreviewCorrection, buildPreview } from '../domain/matcher.ts';
import {
  createFinishedRunState,
  createRunningRunState,
  DEFAULT_RUN_STATE,
  isRunActive,
  mergeRunProgress,
  normalizeRunState
} from '../domain/run-state.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  DebuggerInputOperation,
  ExportSourcesResult,
  FillRunResult,
  PageSegment,
  PopupState,
  RunState,
  RuntimeState,
  StatusKind
} from '../shared/types.ts';
import {
  isGientTransUrl,
  isMemsourceEditorFrameUrl,
  isMemoqUrl,
  isSupportedEditorUrl
} from './editor-url.ts';
import { buildSourceExportWorkbook, parseExcelBuffer } from './excel.ts';
import type { RuntimeStateUpdate } from './storage.ts';

const STOP_ERROR_MESSAGE = 'Operation stopped by user.';
const EXPORT_SCAN_MAX_PASSES = 1200;
const EXPORT_SCAN_MAX_SEGMENTS = 10000;

export interface RuntimeMessageSender {
  tab?: {
    id?: number;
  };
}

export interface BackgroundDebuggerInputPort {
  keepAlive(tabId: number | undefined): void;
  writeText(tabId: number, x: number, y: number, text: string): Promise<void>;
  runSequence(
    tabId: number,
    x: number,
    y: number,
    operations: DebuggerInputOperation[]
  ): Promise<void>;
  prepare(tabId: number): Promise<void>;
}

export interface BackgroundRequestHandlerPort {
  debuggerInput: BackgroundDebuggerInputPort;
  queryActiveTab(): Promise<{ id: number; url?: string }>;
  executeScript(
    tabId: number,
    files: string[],
    options?: { allFrames?: boolean; frameIds?: number[] }
  ): Promise<void>;
  getAllFrames(
    tabId: number
  ): Promise<Array<{ frameId: number; parentFrameId: number; url?: string }>>;
  sendTabMessage<TRequest, TResponse>(
    tabId: number,
    message: TRequest,
    options?: { frameId?: number }
  ): Promise<TResponse>;
  readRuntimeState(): Promise<RuntimeState>;
  writeRuntimeState(update: RuntimeStateUpdate): Promise<void>;
  now(): Date;
  logInfo(message: string, payload: Record<string, unknown>): void;
}

interface EditorTab {
  id: number;
  url?: string;
  frameId?: number;
}

/**
 * Owns background request orchestration while the service-worker entry point
 * only wires Chrome APIs and the runtime listener.
 */
export class BackgroundRequestHandler {
  constructor(private readonly port: BackgroundRequestHandlerPort) {}

  async handle(
    request: BackgroundRequest,
    sender?: RuntimeMessageSender
  ): Promise<ApiResponse<unknown>> {
    switch (request.type) {
      case 'GET_STATE': {
        return { ok: true, data: await this.getPopupState() };
      }

      case 'PARSE_EXCEL': {
        await this.assertNoActiveRun('uploading a new Excel file');
        const parsed = parseExcelBuffer(
          Uint8Array.from(request.payload.bytes),
          request.payload.fileName
        );
        await this.port.writeRuntimeState({
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
        return this.runPreview(request);
      }

      case 'EXPORT_SOURCES': {
        return this.exportSources();
      }

      case 'RUN_FILL': {
        return this.runFill(request);
      }

      case 'STOP_RUN': {
        const state = await this.port.readRuntimeState();
        if (!isRunActive(state.runState)) {
          return { ok: true, data: null };
        }

        await this.port.writeRuntimeState({
          runState: normalizeRunState({
            ...state.runState,
            phase: 'stopping',
            statusKind: 'default',
            lastUpdatedAt: this.port.now().toISOString()
          })
        });
        await this.stopActiveRun(state.runState);
        return { ok: true, data: null };
      }

      case 'SET_FILL_OPTIONS': {
        const fillOptions = normalizeFillOptions(request.payload?.fillOptions);
        await this.port.writeRuntimeState({ fillOptions });
        return { ok: true, data: fillOptions };
      }

      case 'REPORT_RUN_PROGRESS': {
        this.port.debuggerInput.keepAlive(sender?.tab?.id);
        const state = await this.port.readRuntimeState();
        if (
          !isRunActive(state.runState) ||
          !state.runState.runId ||
          state.runState.runId !== request.payload.runId
        ) {
          return { ok: true, data: null };
        }

        await this.port.writeRuntimeState({
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

        await this.port.debuggerInput.writeText(
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

        await this.port.debuggerInput.runSequence(
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

        await this.port.debuggerInput.prepare(tabId);
        return { ok: true, data: null };
      }

      default: {
        throw new Error('Unsupported request.');
      }
    }
  }

  private async runPreview(
    request: Extract<BackgroundRequest, { type: 'RUN_PREVIEW' }>
  ): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (!state.translationEntries.length) {
      throw new Error('Upload an Excel file before running Preview.');
    }
    if (isRunActive(state.runState)) {
      throw new Error('Another task is already running. Stop it before starting Preview.');
    }
    const fillOptions = normalizeFillOptions(
      request.payload?.fillOptions ?? state.fillOptions
    );

    const tab = await this.ensureEditorTab();
    const runState = createRunningRunState('preview', tab);
    await this.port.writeRuntimeState({
      fillOptions,
      runState
    });

    try {
      const response = await this.port.sendTabMessage<
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

      const preview = this.buildPreviewForTab(
        tab.url,
        buildPreview(state.translationEntries, response.data, fillOptions)
      );
      await this.port.writeRuntimeState({
        previewResult: preview,
        fillOptions
      });
      await this.finalizeRunState(runState.runId ?? '', {
        message: `Preview ready. ${preview.readyToFill} segment(s) can be filled.`,
        scannedCount: preview.totalSegments
      });
      return { ok: true, data: preview };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preview failed.';
      await this.finalizeRunState(runState.runId ?? '', {
        message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
        statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error'
      });
      throw error;
    }
  }

  private async exportSources(): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (isRunActive(state.runState)) {
      throw new Error('Another task is already running. Stop it before starting Export.');
    }

    const tab = await this.ensureEditorTab();
    const runState = createRunningRunState('export', tab);
    await this.port.writeRuntimeState({ runState });

    try {
      const response = await this.port.sendTabMessage<
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
        fileName: this.createSourceExportFileName(),
        bytes: Array.from(workbookBytes),
        segmentCount: response.data.length
      };

      await this.finalizeRunState(runState.runId ?? '', {
        message: `Exported ${result.segmentCount} source segment(s).`,
        scannedCount: result.segmentCount
      });

      return { ok: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed.';
      await this.finalizeRunState(runState.runId ?? '', {
        message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
        statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error'
      });
      throw error;
    }
  }

  private async runFill(
    request: Extract<BackgroundRequest, { type: 'RUN_FILL' }>
  ): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (!state.translationEntries.length) {
      throw new Error('Upload an Excel file before running Fill.');
    }
    if (isRunActive(state.runState)) {
      throw new Error('Another task is already running. Stop it before starting Fill.');
    }
    const fillOptions = normalizeFillOptions(request.payload?.fillOptions);
    const plannedFillCount = normalizePlannedFillCount(
      state.previewResult?.readyToFill ??
        state.uploadMeta?.entryCount ??
        state.translationEntries.length
    );

    const tab = await this.ensureEditorTab();
    const runState = createRunningRunState('fill', tab, {
      plannedFillCount
    });
    await this.port.writeRuntimeState({
      fillOptions,
      runState
    });

    try {
      const response = await this.port.sendTabMessage<
        ContentRequest,
        ApiResponse<FillRunResult>
      >(
        tab.id,
        {
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
        },
        tab.frameId ? { frameId: tab.frameId } : undefined
      );

      if (!response.ok) {
        throw new Error(response.error);
      }

      const result = this.finalizePreviewForTab(tab.url, response.data);

      await this.port.writeRuntimeState({
        previewResult: result.preview,
        fillOptions
      });
      await this.finalizeRunState(runState.runId ?? '', {
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
      await this.finalizeRunState(runState.runId ?? '', {
        message: message === STOP_ERROR_MESSAGE ? 'Stopped.' : message,
        statusKind: message === STOP_ERROR_MESSAGE ? 'default' : 'error',
        plannedFillCount
      });
      throw error;
    }
  }

  private finalizePreviewForTab<
    T extends { preview: ReturnType<typeof applyMemoqPreviewCorrection> }
  >(url: string | undefined, result: T): T {
    if (!isMemoqUrl(url)) {
      return result;
    }

    return {
      ...result,
      preview: applyMemoqPreviewCorrection(result.preview)
    };
  }

  private buildPreviewForTab(
    url: string | undefined,
    preview: ReturnType<typeof buildPreview>
  ): ReturnType<typeof buildPreview> {
    return isMemoqUrl(url) ? applyMemoqPreviewCorrection(preview) : preview;
  }

  private async ensureEditorTab(): Promise<EditorTab> {
    const tab = await this.port.queryActiveTab();

    if (!isSupportedEditorUrl(tab.url)) {
      this.port.logInfo('Rejected active tab for CAT run.', { url: tab.url });
      throw new Error(
        'Open a Phrase, memoQ, or GientTrans editor tab before running Preview, Fill, or Export.'
      );
    }

    await this.port.executeScript(tab.id, ['content-script.js'], {
      allFrames: true
    });

    const frames = await this.port.getAllFrames(tab.id);
    const editorFrame = frames.find((frame) =>
      isMemsourceEditorFrameUrl(frame.url)
    );
    this.port.logInfo('Prepared editor tab for CAT run.', {
      tabId: tab.id,
      url: tab.url,
      platform: isGientTransUrl(tab.url)
        ? 'gientrans'
        : isMemoqUrl(tab.url)
          ? 'memoq'
          : 'phrase',
      frameId: editorFrame?.frameId ?? null
    });

    return {
      ...tab,
      frameId: editorFrame?.frameId
    };
  }

  private async finalizeRunState(
    runId: string,
    options: {
      message: string;
      statusKind?: StatusKind;
      scannedCount?: number;
      filledCount?: number;
      plannedFillCount?: number | null;
    }
  ): Promise<void> {
    const latestState = await this.port.readRuntimeState();
    const currentRunState =
      latestState.runState.runId === runId
        ? latestState.runState
        : DEFAULT_RUN_STATE;

    await this.port.writeRuntimeState({
      runState: createFinishedRunState(currentRunState, options)
    });
  }

  private async assertNoActiveRun(action: string): Promise<void> {
    const state = await this.port.readRuntimeState();

    if (!isRunActive(state.runState)) {
      return;
    }

    const activeTaskLabel =
      state.runState.kind === 'preview'
        ? 'Preview'
        : state.runState.kind === 'export'
          ? 'Export'
          : 'Fill';
    throw new Error(
      `${activeTaskLabel} is already running. Stop it before ${action}.`
    );
  }

  private async stopActiveRun(runState?: RunState): Promise<void> {
    const activeRunState =
      runState ?? (await this.port.readRuntimeState()).runState;
    const tabId = activeRunState.tabId;

    if (typeof tabId !== 'number') {
      const tab = await this.ensureEditorTab();
      await this.port.sendTabMessage<ContentRequest, ApiResponse<null>>(
        tab.id,
        { type: 'CONTENT_STOP' },
        tab.frameId ? { frameId: tab.frameId } : undefined
      );
      return;
    }

    await this.port.sendTabMessage<ContentRequest, ApiResponse<null>>(
      tabId,
      { type: 'CONTENT_STOP' },
      typeof activeRunState.frameId === 'number'
        ? { frameId: activeRunState.frameId }
        : undefined
    );
  }

  private async getPopupState(): Promise<PopupState> {
    const state = await this.port.readRuntimeState();

    return {
      uploadMeta: state.uploadMeta,
      previewResult: state.previewResult,
      fillOptions: state.fillOptions,
      runState: state.runState
    };
  }

  private createSourceExportFileName(): string {
    const date = this.port.now().toISOString().slice(0, 10);
    return `memoq-sources-${date}.xlsx`;
  }
}
