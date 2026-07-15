import {
  describeRunState,
  isRunActive,
  normalizeRunState
} from '../domain/run-state.ts';
import { describeRunFailure } from '../domain/run-stop.ts';
import type { BackgroundRequest } from '../shared/message-types.ts';
import type {
  ExportSourcesResult,
  FillOptions,
  FillRunResult,
  PreviewResult
} from '../shared/translation-types.ts';
import type {
  PopupState,
  RunState,
  StatusKind
} from '../shared/state-types.ts';

const REFRESH_INTERVAL_MS = 1000;

export interface PopupFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PopupViewHandlers {
  onUpload(file: PopupFile): void;
  onExport(): void;
  onPreview(): void;
  onFill(): void;
  onStop(): void;
  onAutoStopChange(): void;
  onValidationChange(): void;
}

export interface PopupViewPort {
  bind(handlers: PopupViewHandlers): void;
  setBusy(busy: boolean): void;
  setStopping(stopping: boolean): void;
  renderStatus(message: string, kind?: StatusKind): void;
  renderPreview(preview: PreviewResult | null): void;
  renderFileInfo(popupState: PopupState): void;
  renderFillOptions(fillOptions?: FillOptions | null): void;
  readFillOptions(): FillOptions;
  clearFileSelection(): void;
  downloadExportFile(result: ExportSourcesResult): void;
}

export interface PopupControllerPort {
  view: PopupViewPort;
  sendMessage<T>(message: BackgroundRequest): Promise<T>;
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(timerId: number): void;
}

/**
 * Coordinates popup workflows independently from the concrete DOM view.
 */
export class PopupController {
  private busy = false;
  private stopping = false;
  private refreshTimerId: number | null = null;

  constructor(private readonly port: PopupControllerPort) {}

  start(): void {
    this.port.view.bind({
      onUpload: (file) => {
        void this.handleUpload(file);
      },
      onExport: () => {
        void this.handleExportSources();
      },
      onPreview: () => {
        void this.handlePreview();
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
      onValidationChange: () => {
        void this.persistFillOptions().catch((error) => {
          this.port.view.renderStatus(
            error instanceof Error
              ? error.message
              : 'Failed to save validation setting.',
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
    this.renderRunState(popupState.runState);
    this.port.view.renderFileInfo(popupState);
    this.port.view.renderPreview(popupState.previewResult);
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
      this.setBusy(true);
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
      this.setBusy(false);
    }
  }

  async handlePreview(): Promise<void> {
    try {
      const fillOptions = this.port.view.readFillOptions();
      this.setBusy(true);
      this.setStopping(false);
      this.port.view.renderStatus('Scanning Phrase segments...');
      this.startRefreshLoop();
      const preview = await this.port.sendMessage<PreviewResult>({
        type: 'RUN_PREVIEW',
        payload: { fillOptions }
      });
      this.port.view.renderPreview(preview);
      this.port.view.renderStatus(
        `Preview ready. ${preview.readyToFill} segment(s) can be filled.`
      );
    } catch (error) {
      this.renderOperationError(error, 'Preview failed.');
    } finally {
      this.setStopping(false);
      this.setBusy(false);
      await this.refreshState();
    }
  }

  async handleExportSources(): Promise<void> {
    try {
      this.setBusy(true);
      this.setStopping(false);
      this.port.view.renderStatus('Exporting source segments...');
      this.startRefreshLoop();
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
      this.setStopping(false);
      this.setBusy(false);
      await this.refreshState();
    }
  }

  async handleFill(): Promise<void> {
    try {
      const fillOptions = this.port.view.readFillOptions();
      this.setBusy(true);
      this.setStopping(false);
      this.port.view.renderStatus('Re-scanning and filling segments...');
      this.startRefreshLoop();
      const result = await this.port.sendMessage<FillRunResult>({
        type: 'RUN_FILL',
        payload: { fillOptions }
      });
      this.port.view.renderPreview(result.preview);
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
      this.setStopping(false);
      this.setBusy(false);
      await this.refreshState();
    }
  }

  async handleStop(): Promise<void> {
    if (!this.busy || this.stopping) {
      return;
    }

    try {
      this.setStopping(true);
      this.port.view.renderStatus('Stopping current run...');
      await this.port.sendMessage<null>({ type: 'STOP_RUN' });
    } catch (error) {
      this.setStopping(false);
      this.port.view.renderStatus(
        error instanceof Error ? error.message : 'Stop failed.',
        'error'
      );
    }
  }

  private renderRunState(runState?: RunState | null): void {
    const normalizedRunState = normalizeRunState(runState);
    this.setBusy(isRunActive(normalizedRunState));
    this.setStopping(normalizedRunState.phase === 'stopping');
    this.port.view.renderStatus(
      describeRunState(normalizedRunState),
      normalizedRunState.statusKind
    );

    if (isRunActive(normalizedRunState)) {
      this.startRefreshLoop();
      return;
    }

    this.stopRefreshLoop();
  }

  private setBusy(nextBusy: boolean): void {
    this.busy = nextBusy;
    this.port.view.setBusy(nextBusy);
  }

  private setStopping(nextStopping: boolean): void {
    this.stopping = nextStopping;
    this.port.view.setStopping(nextStopping);
  }

  private startRefreshLoop(): void {
    if (this.refreshTimerId !== null) {
      return;
    }

    this.refreshTimerId = this.port.setInterval(() => {
      void this.refreshState().catch((error) => {
        this.stopRefreshLoop();
        this.port.view.renderStatus(
          error instanceof Error
            ? error.message
            : 'Failed to refresh state.',
          'error'
        );
      });
    }, REFRESH_INTERVAL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimerId === null) {
      return;
    }

    this.port.clearInterval(this.refreshTimerId);
    this.refreshTimerId = null;
  }

  private renderOperationError(error: unknown, fallback: string): void {
    const failure = describeRunFailure(error, fallback);
    this.port.view.renderStatus(failure.message, failure.statusKind);
  }
}
