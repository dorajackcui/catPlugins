import { ContentScriptDomHelpers } from './content/dom.ts';
import {
  replaceRuntimeMessageListener,
  type RuntimeMessageListener
} from './content/runtime-listener.ts';
import { ContentRequestHandler } from './content/request-handler.ts';
import { ContentRunService } from './content/run-service.ts';
import {
  bindStartMarkerListeners,
  clearStartMarker,
  readFreshStartMarker
} from './platforms/start-marker-dom.ts';
import { createPlatformRuntime } from './platforms/runtime.ts';
import { runtimeSendMessage } from './shared/chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest
} from './shared/message-types.ts';
import { delay } from './shared/utils.ts';

declare global {
  interface Window {
    __phraseBulkFillMessageListener?: RuntimeMessageListener<
      ContentRequest,
      ApiResponse<unknown>
    >;
    __phraseBulkFillStopRequested?: boolean;
  }
}

const CONTENT_DEBUG_PREFIX = '[Phrase Bulk Fill]';
const helpers = new ContentScriptDomHelpers();
const platformRuntime = createPlatformRuntime(helpers);

const runService = new ContentRunService({
  runtime: platformRuntime,
  reportProgress: async (runId, progress) => {
    try {
      await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
        type: 'REPORT_RUN_PROGRESS',
        payload: { ...progress, runId }
      });
    } catch {
      // Ignore transient background messaging issues to keep the run alive.
    }
  },
  isStopRequested: () => window.__phraseBulkFillStopRequested === true,
  setStopRequested: (value) => {
    window.__phraseBulkFillStopRequested = value;
  },
  delay,
  readFreshStartMarker,
  clearStartMarker,
  now: () => Date.now(),
  logInfo: (label, payload) =>
    console.info(CONTENT_DEBUG_PREFIX, label, payload),
  logWarn: (label, payload) =>
    console.warn(CONTENT_DEBUG_PREFIX, label, payload),
  logError: (label, payload) =>
    console.error(CONTENT_DEBUG_PREFIX, label, payload)
});
const requestHandler = new ContentRequestHandler(runService);

bindStartMarkerListeners();

replaceRuntimeMessageListener(
  chrome.runtime.onMessage,
  {
    get current() {
      return window.__phraseBulkFillMessageListener;
    },
    set current(listener) {
      window.__phraseBulkFillMessageListener = listener;
    }
  },
  (request, _sender, sendResponse) => {
    void requestHandler.handle(request).then(sendResponse, (error) => {
      sendResponse({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown content-script error.'
      });
    });

    return true;
  }
);
