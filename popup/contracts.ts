import type { BackgroundRequest } from '../shared/message-types.ts';
import type {
  ExportSourcesResult,
  FillOptions,
  PreviewResult
} from '../shared/translation-types.ts';
import type { PopupState, StatusKind } from '../shared/state-types.ts';

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
  onMemoqMarkerFillChange(): void;
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
