import { normalizeFillOptions } from '../domain/fill-options.ts';
import {
  isRunActive,
  mergeRunProgress
} from '../domain/run-state.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation,
  PopupState
} from '../shared/types.ts';
import { parseExcelBuffer } from './excel.ts';
import {
  BackgroundRunCoordinator,
  type BackgroundRunCoordinatorPort
} from './run-coordinator.ts';

export interface RuntimeMessageSender {
  tab?: {
    id?: number;
  };
}

export interface BackgroundDebuggerInputPort {
  keepAlive(tabId: number | undefined): void;
  writeText(tabId: number, x: number, y: number, text: string): Promise<void>;
  runSequence(
    tabId: number,
    x: number,
    y: number,
    operations: DebuggerInputOperation[]
  ): Promise<void>;
  prepare(tabId: number): Promise<void>;
}

export interface BackgroundRequestHandlerPort
  extends BackgroundRunCoordinatorPort {
  debuggerInput: BackgroundDebuggerInputPort;
}

/** Routes background messages to run coordination, state, and debugger ports. */
export class BackgroundRequestHandler {
  private readonly runs: BackgroundRunCoordinator;

  constructor(private readonly port: BackgroundRequestHandlerPort) {
    this.runs = new BackgroundRunCoordinator(port);
  }

  async handle(
    request: BackgroundRequest,
    sender?: RuntimeMessageSender
  ): Promise<ApiResponse<unknown>> {
    switch (request.type) {
      case 'GET_STATE': {
        return { ok: true, data: await this.getPopupState() };
      }

      case 'PARSE_EXCEL': {
        await this.assertNoActiveRun('uploading a new Excel file');
        const parsed = parseExcelBuffer(
          Uint8Array.from(request.payload.bytes),
          request.payload.fileName
        );
        await this.port.writeRuntimeState({
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
        return this.runs.runPreview(request);
      }

      case 'EXPORT_SOURCES': {
        return this.runs.exportSources();
      }

      case 'RUN_FILL': {
        return this.runs.runFill(request);
      }

      case 'STOP_RUN': {
        return this.runs.stop();
      }

      case 'SET_FILL_OPTIONS': {
        const fillOptions = normalizeFillOptions(request.payload?.fillOptions);
        await this.port.writeRuntimeState({ fillOptions });
        return { ok: true, data: fillOptions };
      }

      case 'REPORT_RUN_PROGRESS': {
        this.port.debuggerInput.keepAlive(sender?.tab?.id);
        const state = await this.port.readRuntimeState();
        if (
          !isRunActive(state.runState) ||
          !state.runState.runId ||
          state.runState.runId !== request.payload.runId
        ) {
          return { ok: true, data: null };
        }

        await this.port.writeRuntimeState({
          runState: mergeRunProgress(state.runState, request.payload)
        });
        return { ok: true, data: null };
      }

      case 'MEMOQ_DEBUGGER_WRITE_TEXT':
      case 'DEBUGGER_WRITE_TEXT': {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          throw new Error('Trusted write requires a sender tab.');
        }

        await this.port.debuggerInput.writeText(
          tabId,
          request.payload.x,
          request.payload.y,
          request.payload.text
        );
        return { ok: true, data: null };
      }

      case 'DEBUGGER_INPUT_SEQUENCE': {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          throw new Error('Trusted input sequence requires a sender tab.');
        }

        await this.port.debuggerInput.runSequence(
          tabId,
          request.payload.x,
          request.payload.y,
          request.payload.operations
        );
        return { ok: true, data: null };
      }

      case 'MEMOQ_DEBUGGER_PREPARE': {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number') {
          throw new Error('memoQ trusted input requires a sender tab.');
        }

        await this.port.debuggerInput.prepare(tabId);
        return { ok: true, data: null };
      }

      default: {
        throw new Error('Unsupported request.');
      }
    }
  }

  private async assertNoActiveRun(action: string): Promise<void> {
    const state = await this.port.readRuntimeState();

    if (!isRunActive(state.runState)) {
      return;
    }

    const activeTaskLabel =
      state.runState.kind === 'preview'
        ? 'Preview'
        : state.runState.kind === 'export'
          ? 'Export'
          : 'Fill';
    throw new Error(
      `${activeTaskLabel} is already running. Stop it before ${action}.`
    );
  }

  private async getPopupState(): Promise<PopupState> {
    const state = await this.port.readRuntimeState();

    return {
      uploadMeta: state.uploadMeta,
      previewResult: state.previewResult,
      fillOptions: state.fillOptions,
      runState: state.runState
    };
  }
}
