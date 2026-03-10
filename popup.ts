import { runtimeSendMessage } from './chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  FillRunResult,
  PopupState,
  PreviewResult
} from './types.ts';

const state = {
  busy: false
};

const uploadButton = document.querySelector<HTMLButtonElement>('#upload-button');
const fileInput = document.querySelector<HTMLInputElement>('#file-input');
const previewButton = document.querySelector<HTMLButtonElement>('#preview-button');
const fillButton = document.querySelector<HTMLButtonElement>('#fill-button');
const fileInfo = document.querySelector<HTMLElement>('#file-info');
const statusNode = document.querySelector<HTMLElement>('#status');
const previewNode = document.querySelector<HTMLElement>('#preview-summary');
const previewListNode = document.querySelector<HTMLElement>('#preview-items');

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
    return;
  }

  fileInfo.textContent = `${popupState.uploadMeta.fileName} · ${popupState.uploadMeta.entryCount} rows · sheet ${popupState.uploadMeta.sheetName}`;
  if (previewButton) previewButton.disabled = state.busy;
  if (fillButton) fillButton.disabled = state.busy;
}

async function refreshState(): Promise<void> {
  const popupState = await sendMessage<PopupState>({ type: 'GET_STATE' });
  renderFileInfo(popupState);
  renderPreview(popupState.previewResult);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
    renderStatus('Scanning Phrase segments...');
    const preview = await sendMessage<PreviewResult>({ type: 'RUN_PREVIEW' });
    renderPreview(preview);
    renderStatus(`Preview ready. ${preview.readyToFill} segment(s) can be filled.`);
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Preview failed.', 'error');
  } finally {
    setBusy(false);
    await refreshState();
  }
}

async function handleFill(): Promise<void> {
  try {
    setBusy(true);
    renderStatus('Re-scanning and filling segments...');
    const result = await sendMessage<FillRunResult>({ type: 'RUN_FILL' });
    renderPreview(result.preview);
    renderStatus(`Filled ${result.filledCount} segment(s).`);
  } catch (error) {
    renderStatus(error instanceof Error ? error.message : 'Fill failed.', 'error');
  } finally {
    setBusy(false);
    await refreshState();
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

void refreshState().catch((error) => {
  renderStatus(error instanceof Error ? error.message : 'Failed to load state.', 'error');
});
