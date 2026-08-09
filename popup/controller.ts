import { describeRunFailure } from '../domain/run-stop.ts';
import type {
  ExportSourcesResult,
  FillOptions,
  FillRunResult
} from '../shared/translation-types.ts';
import type { PopupState } from '../shared/state-types.ts';
import type {
  PopupControllerPort,
  PopupFile
} from './contracts.ts';
import { PopupRunMonitor } from './run-monitor.ts';

export type {
  PopupControllerPort,
  PopupFile,
  PopupViewHandlers,
  PopupViewPort
} from './contracts.ts';

/**
 * Coordinates popup workflows independently from the concrete DOM view.
 */
export class PopupController {
  private readonly runMonitor: PopupRunMonitor;

  constructor(private readonly port: PopupControllerPort) {
    this.runMonitor = new PopupRunMonitor({
      view: port.view,
      refreshState: () => this.refreshState(),
      setInterval: (callback, delayMs) =>
        port.setInterval(callback, delayMs),
      clearInterval: (timerId) => port.clearInterval(timerId)
    });
  }

  start(): void {
    this.port.view.bind({
      onUpload: (file) => {
        void this.handleUpload(file);
      },
      onExport: () => {
        void this.handleExportSources();
      },
      onFill: () => {
        void this.handleFill();
      },
      onStop: () => {
        void this.handleStop();
      },
      onAutoStopChange: () => {
        void this.persistFillOptions().catch((error) => {
          this.port.view.renderStatus(
            error instanceof Error
              ? error.message
              : 'Failed to save auto stop setting.',
            'error'
          );
        });
      },
      onMemoqMarkerFillChange: () => {
        void this.persistFillOptions().catch((error) => {
          this.port.view.renderStatus(
            error instanceof Error
              ? error.message
              : 'Failed to save memoQ marker fill setting.',
            'error'
          );
        });
      }
    });

    void this.refreshState().catch((error) => {
      this.port.view.renderStatus(
        error instanceof Error ? error.message : 'Failed to load state.',
        'error'
      );
    });
  }

  async refreshState(): Promise<void> {
    const popupState = await this.port.sendMessage<PopupState>({
      type: 'GET_STATE'
    });
    this.runMonitor.renderRunState(popupState.runState);
    this.port.view.renderFileInfo(popupState);
    this.port.view.renderFillOptions(popupState.fillOptions);
  }

  async persistFillOptions(): Promise<void> {
    const fillOptions = this.port.view.readFillOptions();
    await this.port.sendMessage<FillOptions>({
      type: 'SET_FILL_OPTIONS',
      payload: { fillOptions }
    });
  }

  async handleUpload(file: PopupFile): Promise<void> {
    try {
      this.runMonitor.setBusy(true);
      this.port.view.renderStatus('Parsing Excel...');
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const result = await this.port.sendMessage<{ entryCount: number }>({
        type: 'PARSE_EXCEL',
        payload: { fileName: file.name, bytes }
      });

      this.port.view.renderStatus(
        `Loaded ${result.entryCount} translation rows from ${file.name}.`
      );
      await this.refreshState();
    } catch (error) {
      this.port.view.renderStatus(
        error instanceof Error ? error.message : 'Upload failed.',
        'error'
      );
    } finally {
      this.port.view.clearFileSelection();
      this.runMonitor.setBusy(false);
    }
  }

  async handleExportSources(): Promise<void> {
    try {
      this.runMonitor.beginRun('Exporting source segments...');
      const result = await this.port.sendMessage<ExportSourcesResult>({
        type: 'EXPORT_SOURCES'
      });
      this.port.view.downloadExportFile(result);
      this.port.view.renderStatus(
        `Exported ${result.segmentCount} source segment(s).`
      );
    } catch (error) {
      this.renderOperationError(error, 'Export failed.');
    } finally {
      this.runMonitor.finishRun();
      await this.refreshState();
    }
  }

  async handleFill(): Promise<void> {
    try {
      const fillOptions = this.port.view.readFillOptions();
      this.runMonitor.beginRun('Re-scanning and filling segments...');
      const result = await this.port.sendMessage<FillRunResult>({
        type: 'RUN_FILL',
        payload: { fillOptions }
      });
      const message =
        result.stopReason ??
        (result.stoppedByAutoStop &&
        result.autoStopAfterFilledCount !== null
          ? `Filled ${result.filledCount} segment(s) and auto-stopped at ${result.autoStopAfterFilledCount}.`
          : `Filled ${result.filledCount} segment(s).`);
      this.port.view.renderStatus(
        message,
        result.stopReason ? 'error' : 'default'
      );
    } catch (error) {
      this.renderOperationError(error, 'Fill failed.');
    } finally {
      this.runMonitor.finishRun();
      await this.refreshState();
    }
  }

  async handleStop(): Promise<void> {
    if (!this.runMonitor.tryBeginStop()) {
      return;
    }

    try {
      await this.port.sendMessage<null>({ type: 'STOP_RUN' });
    } catch (error) {
      this.runMonitor.failStop(error);
    }
  }

  private renderOperationError(error: unknown, fallback: string): void {
    const failure = describeRunFailure(error, fallback);
    this.port.view.renderStatus(failure.message, failure.statusKind);
  }
}
