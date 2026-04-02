import { runtimeSendMessage } from './chrome-api.ts';
import { normalizeFillOptions } from './fill-options.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  FillOptions,
  FillRunResult,
  PopupState,
  PreviewResult
} from './types.ts';

const state = {
  busy: false,
  stopping: false
};

const uploadButton = document.querySelector<HTMLButtonElement>('#upload-button');
const fileInput = document.querySelector<HTMLInputElement>('#file-input');
const previewButton = document.querySelector<HTMLButtonElement>('#preview-button');
const fillButton = document.querySelector<HTMLButtonElement>('#fill-button');
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button');
const autoStopCountInput = document.querySelector<HTMLInputElement>('#auto-stop-count');
const fileInfo = document.querySelector<HTMLElement>('#file-info');
const statusNode = document.querySelector<HTMLElement>('#status');
const previewNode = document.querySelector<HTMLElement>('#preview-summary');
const previewListNode = document.querySelector<HTMLElement>('#preview-items');
const STOP_ERROR_MESSAGE = 'Operation stopped by user.';

async function sendMessage<T>(message: BackgroundRequest): Promise<T> {
  const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<T>>(message);
  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}

function setBusy(nextBusy: boolean): void {
  state.busy = nextBusy;
  if (uploadButton) uploadButton.disabled = nextBusy;
  if (previewButton) previewButton.disabled = nextBusy;
  if (fillButton) fillButton.disabled = nextBusy;
  if (stopButton) stopButton.disabled = !nextBusy || state.stopping;
  if (autoStopCountInput) autoStopCountInput.disabled = nextBusy;
}

function setStopping(nextStopping: boolean): void {
  state.stopping = nextStopping;
  if (stopButton) stopButton.disabled = !state.busy || nextStopping;
}

function renderStatus(message: string, kind: 'default' | 'error' = 'default'): void {
  if (!statusNode) {
    return;
  }

  statusNode.textContent = message;
  statusNode.dataset.kind = kind;
}

function renderPreview(preview: PreviewResult | null): void {
  if (!previewNode || !previewListNode) {
    return;
  }

  if (!preview) {
    previewNode.innerHTML = '<li>Total segments: -</li><li>Matched: -</li><li>Already translated: -</li><li>Placeholder errors: -</li><li>Ready to fill: -</li><li>Skipped: -</li>';
    previewListNode.innerHTML = '';
    return;
  }

  previewNode.innerHTML = [
    `Total segments: ${preview.totalSegments}`,
    `Matched: ${preview.matched}`,
    `Already translated: ${preview.alreadyTranslated}`,
    `Placeholder errors: ${preview.placeholderErrors}`,
    `Ready to fill: ${preview.readyToFill}`,
    `Skipped: ${preview.skipped}`
  ]
    .map((line) => `<li>${line}</li>`)
    .join('');

  const readyItems = preview.items.filter((item) => item.status === 'ready').slice(0, 15);

  previewListNode.innerHTML = readyItems.length
    ? readyItems
        .map((item) => `<li>${escapeHtml(item.sourceRaw)}</li>`)
        .join('')
    : '<li>No fillable segments in the current preview.</li>';
}

function renderFileInfo(popupState: PopupState): void {
  if (!fileInfo) {
    return;
  }

  if (!popupState.uploadMeta) {
    fileInfo.textContent = 'No Excel file uploaded yet.';
    if (previewButton) previewButton.disabled = true;
    if (fillButton) fillButton.disabled = true;
    if (stopButton) stopButton.disabled = true;
    return;
  }

  fileInfo.textContent = `${popupState.uploadMeta.fileName} · ${popupState.uploadMeta.entryCount} rows · sheet ${popupState.uploadMeta.sheetName}`;
  if (previewButton) previewButton.disabled = state.busy;
  if (fillButton) fillButton.disabled = state.busy;
  if (stopButton) stopButton.disabled = !state.busy || state.stopping;
}

async function refreshState(): Promise<void> {
  const popupState = await sendMessage<PopupState>({ type: 'GET_STATE' });
  renderFileInfo(popupState);
  renderPreview(popupState.previewResult);
  renderFillOptions(popupState.fillOptions);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderFillOptions(fillOptions?: FillOptions | null): void {
  if (!autoStopCountInput) {
    return;
  }

  const normalizedFillOptions = normalizeFillOptions(fillOptions);

  autoStopCountInput.value =
    normalizedFillOptions.autoStopAfterFilledCount === null
      ? ''
      : String(normalizedFillOptions.autoStopAfterFilledCount);
}

function readFillOptions(): FillOptions {
  const rawValue = autoStopCountInput?.value.trim() ?? '';

  if (!rawValue) {
    return {
      autoStopAfterFilledCount: null
    };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('Auto stop count must be a positive number.');
  }

  return {
    autoStopAfterFilledCount: Math.floor(parsed)
  };
}

async function persistFillOptions(): Promise<void> {
  const fillOptions = readFillOptions();
  await sendMessage<FillOptions>({
    type: 'SET_FILL_OPTIONS',
    payload: { fillOptions }
  });
}

async function handleUpload(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  try {
    setBusy(true);
    renderStatus('Parsing Excel...');
    const buffer = await file.arrayBuffer();
    const bytes = Array.from(new Uint8Array(buffer));
    const result = await sendMessage<{ entryCount: number }>({
      type: 'PARSE_EXCEL',
      payload: { fileName: file.name, bytes }
    });

    renderStatus(`Loaded ${result.entryCount} translation rows from ${file.name}.`);
    await refreshState();
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Upload failed.', 'error');
  } finally {
    input.value = '';
    setBusy(false);
  }
}

async function handlePreview(): Promise<void> {
  try {
    setBusy(true);
    setStopping(false);
    renderStatus('Scanning Phrase segments...');
    const preview = await sendMessage<PreviewResult>({ type: 'RUN_PREVIEW' });
    renderPreview(preview);
    renderStatus(`Preview ready. ${preview.readyToFill} segment(s) can be filled.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview failed.';
    renderStatus(message === STOP_ERROR_MESSAGE ? 'Stopped.' : message, message === STOP_ERROR_MESSAGE ? 'default' : 'error');
  } finally {
    setStopping(false);
    setBusy(false);
    await refreshState();
  }
}

async function handleFill(): Promise<void> {
  try {
    const fillOptions = readFillOptions();
    setBusy(true);
    setStopping(false);
    renderStatus('Re-scanning and filling segments...');
    const result = await sendMessage<FillRunResult>({
      type: 'RUN_FILL',
      payload: { fillOptions }
    });
    renderPreview(result.preview);
    renderStatus(
      result.stoppedByAutoStop && result.autoStopAfterFilledCount !== null
        ? `Filled ${result.filledCount} segment(s) and auto-stopped at ${result.autoStopAfterFilledCount}.`
        : `Filled ${result.filledCount} segment(s).`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fill failed.';
    renderStatus(message === STOP_ERROR_MESSAGE ? 'Stopped.' : message, message === STOP_ERROR_MESSAGE ? 'default' : 'error');
  } finally {
    setStopping(false);
    setBusy(false);
    await refreshState();
  }
}

async function handleStop(): Promise<void> {
  if (!state.busy || state.stopping) {
    return;
  }

  try {
    setStopping(true);
    renderStatus('Stopping current run...');
    await sendMessage<null>({ type: 'STOP_RUN' });
  } catch (error) {
    setStopping(false);
    renderStatus(error instanceof Error ? error.message : 'Stop failed.', 'error');
  }
}

uploadButton?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', (event) => {
  void handleUpload(event);
});
previewButton?.addEventListener('click', () => {
  void handlePreview();
});
fillButton?.addEventListener('click', () => {
  void handleFill();
});
stopButton?.addEventListener('click', () => {
  void handleStop();
});
autoStopCountInput?.addEventListener('change', () => {
  void persistFillOptions().catch((error) => {
    renderStatus(error instanceof Error ? error.message : 'Failed to save auto stop setting.', 'error');
  });
});

void refreshState().catch((error) => {
  renderStatus(error instanceof Error ? error.message : 'Failed to load state.', 'error');
});
