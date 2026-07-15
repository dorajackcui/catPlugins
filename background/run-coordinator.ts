import { normalizeFillOptions } from '../domain/fill-options.ts';
import { normalizePlannedFillCount } from '../domain/fill-throttle.ts';
import { applyMemoqPreviewCorrection, buildPreview } from '../domain/matcher.ts';
import {
  createFinishedRunState,
  createRunningRunState,
  DEFAULT_RUN_STATE,
  isRunActive,
  normalizeRunState
} from '../domain/run-state.ts';
import type {
  ApiResponse,
  BackgroundRequest
} from '../shared/message-types.ts';
import type {
  ExportSourcesResult,
  FillRunResult,
  PageSegment
} from '../shared/translation-types.ts';
import type {
  RuntimeState,
  StatusKind
} from '../shared/state-types.ts';
import {
  BackgroundEditorSession,
  type BackgroundEditorSessionPort
} from './editor-session.ts';
import { isMemoqUrl } from './editor-url.ts';
import { buildSourceExportWorkbook } from './excel.ts';
import type { RuntimeStateUpdate } from './storage.ts';

const STOP_ERROR_MESSAGE = 'Operation stopped by user.';
const EXPORT_SCAN_MAX_PASSES = 1200;
const EXPORT_SCAN_MAX_SEGMENTS = 10000;

export interface BackgroundRunCoordinatorPort
  extends BackgroundEditorSessionPort {
  readRuntimeState(): Promise<RuntimeState>;
  writeRuntimeState(update: RuntimeStateUpdate): Promise<void>;
  now(): Date;
}

/** Coordinates Preview, Export, Fill, and Stop run lifecycles. */
export class BackgroundRunCoordinator {
  private readonly editorSession: BackgroundEditorSession;

  constructor(private readonly port: BackgroundRunCoordinatorPort) {
    this.editorSession = new BackgroundEditorSession(port);
  }

  async runPreview(
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

    const tab = await this.editorSession.prepare();
    const runState = createRunningRunState('preview', tab);
    await this.port.writeRuntimeState({
      fillOptions,
      runState
    });

    try {
      const segments = await this.editorSession.request<PageSegment[]>(
        tab,
        {
          type: 'CONTENT_SCAN',
          payload: {
            runId: runState.runId ?? ''
          }
        }
      );

      const preview = this.buildPreviewForTab(
        tab.url,
        buildPreview(state.translationEntries, segments, fillOptions)
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

  async exportSources(): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (isRunActive(state.runState)) {
      throw new Error('Another task is already running. Stop it before starting Export.');
    }

    const tab = await this.editorSession.prepare();
    const runState = createRunningRunState('export', tab);
    await this.port.writeRuntimeState({ runState });

    try {
      const segments = await this.editorSession.request<PageSegment[]>(
        tab,
        {
          type: 'CONTENT_SCAN',
          payload: {
            runId: runState.runId ?? '',
            maxPasses: EXPORT_SCAN_MAX_PASSES,
            maxSegments: EXPORT_SCAN_MAX_SEGMENTS,
            scanFromTop: true
          }
        }
      );

      const workbookBytes = buildSourceExportWorkbook(segments);
      const result: ExportSourcesResult = {
        fileName: this.createSourceExportFileName(),
        bytes: Array.from(workbookBytes),
        segmentCount: segments.length
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

  async runFill(
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

    const tab = await this.editorSession.prepare();
    const runState = createRunningRunState('fill', tab, {
      plannedFillCount
    });
    await this.port.writeRuntimeState({
      fillOptions,
      runState
    });

    try {
      const fillResult = await this.editorSession.request<FillRunResult>(
        tab,
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
        }
      );

      const result = this.finalizePreviewForTab(tab.url, fillResult);

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

  async stop(): Promise<ApiResponse<unknown>> {
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
    await this.editorSession.stop(state.runState);
    return { ok: true, data: null };
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

  private createSourceExportFileName(): string {
    const date = this.port.now().toISOString().slice(0, 10);
    return `memoq-sources-${date}.xlsx`;
  }
}
