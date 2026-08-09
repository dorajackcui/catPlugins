import { normalizeFillOptions } from '../domain/fill-options.ts';
import type {
  ExportSourcesResult,
  FillOptions,
  PreviewResult
} from '../shared/translation-types.ts';
import type { PopupState, StatusKind } from '../shared/state-types.ts';
import type {
  PopupViewHandlers,
  PopupViewPort
} from './contracts.ts';

const EMPTY_PREVIEW_SUMMARY_HTML =
  '<li>Total segments: -</li><li>Matched: -</li><li>Already translated: -</li><li>Tag / placeholder errors: -</li><li>Ready to fill: -</li><li>Skipped: -</li>';

export function escapePopupHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildPreviewSummaryHtml(
  preview: PreviewResult | null
): string {
  if (!preview) {
    return EMPTY_PREVIEW_SUMMARY_HTML;
  }

  return [
    `Total segments: ${preview.totalSegments}`,
    `Matched: ${preview.matched}`,
    `Already translated: ${preview.alreadyTranslated}`,
    `Tag / placeholder errors: ${preview.placeholderErrors}`,
    `Ready to fill: ${preview.readyToFill}`,
    `Skipped: ${preview.skipped}`
  ]
    .map((line) => `<li>${line}</li>`)
    .join('');
}

export function buildPreviewItemsHtml(preview: PreviewResult | null): string {
  if (!preview) {
    return '';
  }

  const readyItems = preview.items
    .filter((item) => item.status === 'ready')
    .slice(0, 15);

  return readyItems.length
    ? readyItems
        .map((item) => `<li>${escapePopupHtml(item.sourceRaw)}</li>`)
        .join('')
    : '<li>No fillable segments in the current preview.</li>';
}

export function parsePopupFillOptions(
  rawValue: string,
  validatePlaceholders: boolean,
  enableMemoqMarkerFill = false
): FillOptions {
  const normalizedValue = rawValue.trim();
  if (!normalizedValue) {
    return {
      autoStopAfterFilledCount: null,
      validatePlaceholders,
      enableMemoqMarkerFill
    };
  }

  const parsed = Number(normalizedValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Auto stop count must be a positive number.');
  }

  return {
    autoStopAfterFilledCount: Math.floor(parsed),
    validatePlaceholders,
    enableMemoqMarkerFill
  };
}

/** Owns popup DOM rendering, controls, events, and browser downloads. */
export class PopupView implements PopupViewPort {
  private busy = false;
  private stopping = false;

  private readonly uploadButton: HTMLButtonElement | null;
  private readonly fileInput: HTMLInputElement | null;
  private readonly exportButton: HTMLButtonElement | null;
  private readonly previewButton: HTMLButtonElement | null;
  private readonly fillButton: HTMLButtonElement | null;
  private readonly stopButton: HTMLButtonElement | null;
  private readonly autoStopCountInput: HTMLInputElement | null;
  private readonly validatePlaceholdersInput: HTMLInputElement | null;
  private readonly enableMemoqMarkerFillInput: HTMLInputElement | null;
  private readonly fileInfo: HTMLElement | null;
  private readonly statusNode: HTMLElement | null;
  private readonly previewNode: HTMLElement | null;
  private readonly previewListNode: HTMLElement | null;

  constructor(
    private readonly document: Document,
    private readonly window: Window
  ) {
    this.uploadButton = document.querySelector<HTMLButtonElement>('#upload-button');
    this.fileInput = document.querySelector<HTMLInputElement>('#file-input');
    this.exportButton = document.querySelector<HTMLButtonElement>('#export-button');
    this.previewButton = document.querySelector<HTMLButtonElement>('#preview-button');
    this.fillButton = document.querySelector<HTMLButtonElement>('#fill-button');
    this.stopButton = document.querySelector<HTMLButtonElement>('#stop-button');
    this.autoStopCountInput = document.querySelector<HTMLInputElement>(
      '#auto-stop-count'
    );
    this.validatePlaceholdersInput = document.querySelector<HTMLInputElement>(
      '#validate-placeholders'
    );
    this.enableMemoqMarkerFillInput = document.querySelector<HTMLInputElement>(
      '#enable-memoq-marker-fill'
    );
    this.fileInfo = document.querySelector<HTMLElement>('#file-info');
    this.statusNode = document.querySelector<HTMLElement>('#status');
    this.previewNode = document.querySelector<HTMLElement>('#preview-summary');
    this.previewListNode = document.querySelector<HTMLElement>('#preview-items');
  }

  bind(handlers: PopupViewHandlers): void {
    this.uploadButton?.addEventListener('click', () => this.fileInput?.click());
    this.fileInput?.addEventListener('change', () => {
      const file = this.fileInput?.files?.[0];
      if (file) {
        handlers.onUpload(file);
      }
    });
    this.exportButton?.addEventListener('click', handlers.onExport);
    this.previewButton?.addEventListener('click', handlers.onPreview);
    this.fillButton?.addEventListener('click', handlers.onFill);
    this.stopButton?.addEventListener('click', handlers.onStop);
    this.autoStopCountInput?.addEventListener(
      'change',
      handlers.onAutoStopChange
    );
    this.validatePlaceholdersInput?.addEventListener(
      'change',
      handlers.onValidationChange
    );
    this.enableMemoqMarkerFillInput?.addEventListener(
      'change',
      handlers.onMemoqMarkerFillChange
    );
  }

  setBusy(nextBusy: boolean): void {
    this.busy = nextBusy;
    if (this.uploadButton) this.uploadButton.disabled = nextBusy;
    if (this.exportButton) this.exportButton.disabled = nextBusy;
    if (this.previewButton) this.previewButton.disabled = nextBusy;
    if (this.fillButton) this.fillButton.disabled = nextBusy;
    if (this.stopButton) {
      this.stopButton.disabled = !nextBusy || this.stopping;
    }
    if (this.autoStopCountInput) {
      this.autoStopCountInput.disabled = nextBusy;
    }
    if (this.validatePlaceholdersInput) {
      this.validatePlaceholdersInput.disabled = nextBusy;
    }
    if (this.enableMemoqMarkerFillInput) {
      this.enableMemoqMarkerFillInput.disabled = nextBusy;
    }
  }

  setStopping(nextStopping: boolean): void {
    this.stopping = nextStopping;
    if (this.stopButton) {
      this.stopButton.disabled = !this.busy || nextStopping;
    }
  }

  renderStatus(
    message: string,
    kind: StatusKind = 'default'
  ): void {
    if (!this.statusNode) {
      return;
    }

    this.statusNode.textContent = message;
    this.statusNode.dataset.kind = kind;
  }

  renderPreview(preview: PreviewResult | null): void {
    if (!this.previewNode || !this.previewListNode) {
      return;
    }

    this.previewNode.innerHTML = buildPreviewSummaryHtml(preview);
    this.previewListNode.innerHTML = buildPreviewItemsHtml(preview);
  }

  renderFileInfo(popupState: PopupState): void {
    if (!this.fileInfo) {
      return;
    }

    if (!popupState.uploadMeta) {
      this.fileInfo.textContent = 'No Excel file uploaded yet.';
      if (this.exportButton) this.exportButton.disabled = this.busy;
      if (this.previewButton) this.previewButton.disabled = true;
      if (this.fillButton) this.fillButton.disabled = true;
      if (this.stopButton) this.stopButton.disabled = true;
      return;
    }

    this.fileInfo.textContent =
      `${popupState.uploadMeta.fileName} · ` +
      `${popupState.uploadMeta.entryCount} rows · ` +
      `sheet ${popupState.uploadMeta.sheetName}`;
    if (this.exportButton) this.exportButton.disabled = this.busy;
    if (this.previewButton) this.previewButton.disabled = this.busy;
    if (this.fillButton) this.fillButton.disabled = this.busy;
    if (this.stopButton) {
      this.stopButton.disabled = !this.busy || this.stopping;
    }
  }

  renderFillOptions(fillOptions?: FillOptions | null): void {
    if (
      !this.autoStopCountInput ||
      !this.validatePlaceholdersInput ||
      !this.enableMemoqMarkerFillInput
    ) {
      return;
    }

    const normalizedFillOptions = normalizeFillOptions(fillOptions);
    this.autoStopCountInput.value =
      normalizedFillOptions.autoStopAfterFilledCount === null
        ? ''
        : String(normalizedFillOptions.autoStopAfterFilledCount);
    this.validatePlaceholdersInput.checked =
      normalizedFillOptions.validatePlaceholders;
    this.enableMemoqMarkerFillInput.checked =
      normalizedFillOptions.enableMemoqMarkerFill === true;
  }

  readFillOptions(): FillOptions {
    return parsePopupFillOptions(
      this.autoStopCountInput?.value ?? '',
      this.validatePlaceholdersInput?.checked !== false,
      this.enableMemoqMarkerFillInput?.checked === true
    );
  }

  clearFileSelection(): void {
    if (this.fileInput) {
      this.fileInput.value = '';
    }
  }

  downloadExportFile(result: ExportSourcesResult): void {
    const blob = new Blob([Uint8Array.from(result.bytes)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const link = this.document.createElement('a');
    link.href = url;
    link.download = result.fileName;
    link.style.display = 'none';
    this.document.body.append(link);
    link.click();
    link.remove();
    this.window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
