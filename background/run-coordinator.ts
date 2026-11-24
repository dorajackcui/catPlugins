import { normalizeFillOptions } from '../domain/fill-options.ts';
import { describeFillResult } from '../domain/fill-failure.ts';
import { normalizePlannedFillCount } from '../domain/fill-throttle.ts';
import { buildPreview } from '../domain/matcher.ts';
import { isRunActive } from '../domain/run-state.ts';
import type {
  ApiResponse,
  BackgroundRequest
} from '../shared/message-types.ts';
import type { RuntimeState } from '../shared/state-types.ts';
import type {
  ExportSourcesResult,
  FillRunResult,
  PageSegment
} from '../shared/translation-types.ts';
import {
  BackgroundEditorSession,
  type BackgroundEditorSessionPort
} from './editor-session.ts';
import { requireEditorPlatform, type EditorPlatform } from '../shared/editor-platform.ts';
import { buildSourceExportWorkbook } from './excel.ts';
import {
  BackgroundRunLifecycle,
  type BackgroundRunLifecyclePort
} from './run-lifecycle.ts';

const EXPORT_SCAN_MAX_PASSES = 1200;
const EXPORT_SCAN_MAX_SEGMENTS = 10000;

export interface BackgroundRunCoordinatorPort
  extends BackgroundEditorSessionPort,
    BackgroundRunLifecyclePort {}

/** Coordinates Preview, Export, Fill, and Stop workflows. */
export class BackgroundRunCoordinator {
  private readonly editorSession: BackgroundEditorSession;
  private readonly lifecycle: BackgroundRunLifecycle;

  constructor(private readonly port: BackgroundRunCoordinatorPort) {
    this.editorSession = new BackgroundEditorSession(port);
    this.lifecycle = new BackgroundRunLifecycle(port);
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

    const editorPlatform = requireEditorPlatform(state.editorPlatform);
    const tab = await this.editorSession.prepare(editorPlatform);
    const runState = await this.lifecycle.start('preview', tab, {
      fillOptions
    });

    try {
      const segments = await this.editorSession.request<PageSegment[]>(
        tab,
        {
          type: 'CONTENT_SCAN',
          payload: {
            runId: runState.runId ?? '',
            editorPlatform
          }
        }
      );

      const preview = buildPreview(state.translationEntries, segments, fillOptions);
      await this.port.writeRuntimeState({
        previewResult: preview,
        fillOptions
      });
      await this.lifecycle.finish(runState.runId ?? '', {
        message: `Preview ready. ${preview.readyToFill} segment(s) can be filled.`,
        scannedCount: preview.totalSegments
      });
      return { ok: true, data: preview };
    } catch (error) {
      await this.lifecycle.finishFailure(
        runState.runId ?? '',
        error,
        'Preview failed.'
      );
      throw error;
    }
  }

  async exportSources(): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (isRunActive(state.runState)) {
      throw new Error('Another task is already running. Stop it before starting Export.');
    }

    const editorPlatform = requireEditorPlatform(state.editorPlatform);
    const tab = await this.editorSession.prepare(editorPlatform);
    const runState = await this.lifecycle.start('export', tab);

    try {
      const segments = await this.editorSession.request<PageSegment[]>(
        tab,
        {
          type: 'CONTENT_SCAN',
          payload: {
            runId: runState.runId ?? '',
            editorPlatform,
            maxPasses: EXPORT_SCAN_MAX_PASSES,
            maxSegments: EXPORT_SCAN_MAX_SEGMENTS,
            scanFromTop: true,
            ...(editorPlatform === 'memoq' ? { readOriginalTags: true } : {})
          }
        }
      );

      if (editorPlatform === 'gientrans' && segments.length === 0) {
        throw new Error('No GientTrans source segments found. Check that the active editor has loaded and its filters show rows, then export again.');
      }
      const workbookBytes = buildSourceExportWorkbook(segments);
      const result: ExportSourcesResult = {
        fileName: this.createSourceExportFileName(editorPlatform, tab.url),
        bytes: Array.from(workbookBytes),
        segmentCount: segments.length
      };

      await this.lifecycle.finish(runState.runId ?? '', {
        message: `Exported ${result.segmentCount} source segment(s).`,
        scannedCount: result.segmentCount
      });

      return { ok: true, data: result };
    } catch (error) {
      await this.lifecycle.finishFailure(
        runState.runId ?? '',
        error,
        'Export failed.'
      );
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
    const editorPlatform = requireEditorPlatform(state.editorPlatform);
    // The current memoQ filter is read during Fill. A previous partial scan
    // cannot supply a total for the next run.
    const plannedFillCount = editorPlatform === 'memoq' ? null : normalizePlannedFillCount(
      state.previewResult?.readyToFill ??
        state.uploadMeta?.entryCount ??
        state.translationEntries.length
    );

    const tab = await this.editorSession.prepare(editorPlatform);
    const runState = await this.lifecycle.start('fill', tab, {
      fillOptions,
      plannedFillCount
    });

    try {
      const result = await this.editorSession.request<FillRunResult>(
        tab,
        {
          type: 'CONTENT_FILL',
          payload: {
            runId: runState.runId ?? '',
            editorPlatform,
            entries: state.translationEntries,
            fillOptions,
            plannedFillCount,
            ...(editorPlatform === 'memoq'
              ? {
                  maxPasses: EXPORT_SCAN_MAX_PASSES,
                  maxSegments: EXPORT_SCAN_MAX_SEGMENTS,
                  scanFromTop: true
                }
              : {})
          }
        }
      );

      await this.port.writeRuntimeState({
        previewResult: result.preview,
        fillOptions
      });
      await this.lifecycle.finish(runState.runId ?? '', {
        message: describeFillResult(result),
        filledCount: result.filledCount,
        scannedCount: result.preview.totalSegments,
        plannedFillCount
      });
      return { ok: true, data: result };
    } catch (error) {
      await this.lifecycle.finishFailure(
        runState.runId ?? '',
        error,
        'Fill failed.',
        { plannedFillCount }
      );
      throw error;
    }
  }

  async readPopupState(): Promise<RuntimeState> {
    const state = await this.port.readRuntimeState();
    const run = state.runState;
    if (run.phase === 'stopping' && run.runId && await this.editorSession.receiverIsGone(run)) {
      await this.lifecycle.finish(run.runId, {
        message: 'Stopped. The editor was closed or reloaded.'
      });
      return this.port.readRuntimeState();
    }
    return state;
  }

  async stop(): Promise<ApiResponse<unknown>> {
    const state = await this.port.readRuntimeState();
    if (!isRunActive(state.runState)) {
      return { ok: true, data: null };
    }

    await this.lifecycle.markStopping(state.runState);
    await this.editorSession.stop(state.runState, state.editorPlatform);
    return { ok: true, data: null };
  }

  private createSourceExportFileName(platform: EditorPlatform, url?: string): string {
    const date = this.port.now().toISOString().slice(0, 10);
    if (platform === 'gientrans') {
      const taskId = url ? extractGientTransTaskId(url) : null;
      return taskId
        ? `gientrans-sources-${taskId}-${date}.xlsx`
        : `gientrans-sources-${date}.xlsx`;
    }

    return `${platform}-sources-${date}.xlsx`;
  }
}

function extractGientTransTaskId(url: string): string | null {
  try {
    const hash = new URL(url).hash;
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) {
      return null;
    }

    const taskId = new URLSearchParams(hash.slice(queryIndex + 1))
      .get('taskId')
      ?.trim();

    return taskId && /^[A-Za-z0-9_-]+$/.test(taskId) ? taskId : null;
  } catch {
    return null;
  }
}
