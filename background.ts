import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import { parseExcelBuffer } from './excel.ts';
import { applyMemoqPreviewCorrection, buildPreview } from './matcher.ts';
import { readRuntimeState, writeRuntimeState } from './storage.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  FillRunResult,
  PageSegment,
  PopupState
} from './types.ts';

const MEMOQ_URL_RE = /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/webpm\/webtrans\//;
const MEMSOURCE_JOB_URL_RE =
  /^https:\/\/cloud\.memsource\.com\/web\/job\/[^/]+\/translate(?:[/?#]|$)/;
const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;

function isPhraseEditorUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('https://app.phrase.com/editor/') ||
    MEMSOURCE_JOB_URL_RE.test(url) ||
    MEMOQ_URL_RE.test(url)
  );
}

function isMemoqUrl(url?: string): boolean {
  return Boolean(url && MEMOQ_URL_RE.test(url));
}

function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
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

  if (!isPhraseEditorUrl(tab.url)) {
    throw new Error('Open a Phrase editor tab before running Preview or Fill.');
  }

  await executeScript(tab.id, ['content-script.js'], { allFrames: true });

  const frames = await getAllFrames(tab.id);
  const editorFrame = frames.find((frame) => isMemsourceEditorFrameUrl(frame.url));

  return {
    ...tab,
    frameId: editorFrame?.frameId
  };
}

async function getPopupState(): Promise<PopupState> {
  const state = await readRuntimeState();

  return {
    uploadMeta: state.uploadMeta,
    previewResult: state.previewResult
  };
}

async function handleMessage(request: BackgroundRequest): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'GET_STATE': {
      return { ok: true, data: await getPopupState() };
    }

    case 'PARSE_EXCEL': {
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

      const tab = await ensurePhraseTab();
      const response = await sendTabMessage<
        ContentRequest,
        ApiResponse<PageSegment[]>
      >(tab.id, { type: 'CONTENT_SCAN' }, tab.frameId ? { frameId: tab.frameId } : undefined);

      if (!response.ok) {
        throw new Error(response.error);
      }

      const preview = buildPreviewForTab(
        tab.url,
        buildPreview(state.translationEntries, response.data)
      );
      await writeRuntimeState({ previewResult: preview });
      return { ok: true, data: preview };
    }

    case 'RUN_FILL': {
      const state = await readRuntimeState();
      if (!state.translationEntries.length) {
        throw new Error('Upload an Excel file before running Fill.');
      }

      const tab = await ensurePhraseTab();
      const response = await sendTabMessage<
        ContentRequest,
        ApiResponse<FillRunResult>
      >(tab.id, {
        type: 'CONTENT_FILL',
        payload: { entries: state.translationEntries }
      }, tab.frameId ? { frameId: tab.frameId } : undefined);

      if (!response.ok) {
        throw new Error(response.error);
      }

      const result = finalizePreviewForTab(tab.url, response.data);

      await writeRuntimeState({ previewResult: result.preview });
      return { ok: true, data: result };
    }

    default: {
      throw new Error('Unsupported request.');
    }
  }
}

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    _sender: unknown,
    sendResponse: (response: ApiResponse<unknown>) => void
  ) => {
    void (async () => {
      try {
        sendResponse(await handleMessage(request));
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
