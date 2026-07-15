import {
  executeScript,
  getAllFrames,
  queryActiveTab,
  sendTabMessage
} from './shared/chrome-api.ts';
import { DebuggerInputController } from './background/debugger-input.ts';
import {
  BackgroundRequestHandler,
  type RuntimeMessageSender
} from './background/request-handler.ts';
import {
  readRuntimeState,
  writeRuntimeState
} from './background/storage.ts';
import type {
  ApiResponse,
  BackgroundRequest
} from './shared/message-types.ts';

const DEBUG_PREFIX = '[Phrase Bulk Fill]';
const debuggerInput = new DebuggerInputController(chrome);
const requestHandler = new BackgroundRequestHandler({
  debuggerInput,
  queryActiveTab,
  executeScript,
  getAllFrames,
  sendTabMessage,
  readRuntimeState,
  writeRuntimeState,
  now: () => new Date(),
  logInfo: (message, payload) =>
    console.info(DEBUG_PREFIX, message, payload)
});

chrome.runtime.onMessage.addListener(
  (
    request: BackgroundRequest,
    sender: RuntimeMessageSender,
    sendResponse: (response: ApiResponse<unknown>) => void
  ) => {
    void (async () => {
      try {
        sendResponse(await requestHandler.handle(request, sender));
      } catch (error) {
        sendResponse({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Unknown background error.'
        });
      }
    })();

    return true;
  }
);
