import { executeScript, getAllFrames, queryActiveTab, sendTabMessage } from './chrome-api.ts';
import { parseExcelBuffer } from './excel.ts';
import { buildPreview } from './matcher.ts';
import { readRuntimeState, writeRuntimeState } from './storage.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  FillRunResult,
  PageSegment,
  PopupState
} from './types.ts';

function isPhraseEditorUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('https://app.phrase.com/editor/') ||
    /^https:\/\/cloud\.memsource\.com\/web\/job\/[^/]+\/translate(?:[/?#]|$)/.test(url) ||
    /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/webpm\/webtrans\//.test(url)
  );
}

function isMemsourceEditorFrameUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/.test(url);
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
    previewResult: state.previewResult,
    hasEntries: state.translationEntries.length > 0
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
          uploadMeta: parsed.meta,
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

      const preview = buildPreview(state.translationEntries, response.data);
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

      await writeRuntimeState({ previewResult: response.data.preview });
      return { ok: true, data: response.data };
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
