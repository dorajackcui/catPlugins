import type { RunPhase } from './state-types.ts';
import type { FillOptions, TranslationEntry } from './translation-types.ts';

export interface ParseExcelRequest {
  type: 'PARSE_EXCEL';
  payload: {
    fileName: string;
    bytes: number[];
  };
}

export interface RunPreviewRequest {
  type: 'RUN_PREVIEW';
  payload?: {
    fillOptions?: FillOptions;
  };
}

export interface RunFillRequest {
  type: 'RUN_FILL';
  payload: {
    fillOptions: FillOptions;
  };
}

export interface ExportSourcesRequest {
  type: 'EXPORT_SOURCES';
}

export interface StopRunRequest {
  type: 'STOP_RUN';
}

export interface GetStateRequest {
  type: 'GET_STATE';
}

export interface SetFillOptionsRequest {
  type: 'SET_FILL_OPTIONS';
  payload: {
    fillOptions: FillOptions;
  };
}

export interface ReportRunProgressRequest {
  type: 'REPORT_RUN_PROGRESS';
  payload: {
    runId: string;
    phase?: Extract<RunPhase, 'running' | 'stopping'>;
    scannedCount?: number;
    filledCount?: number;
    plannedFillCount?: number | null;
    message?: string;
  };
}

export interface MemoqDebuggerPrepareRequest {
  type: 'MEMOQ_DEBUGGER_PREPARE';
}

export interface MemoqDebuggerWriteTextRequest {
  type: 'MEMOQ_DEBUGGER_WRITE_TEXT';
  payload: {
    x: number;
    y: number;
    text: string;
  };
}

export interface DebuggerWriteTextRequest {
  type: 'DEBUGGER_WRITE_TEXT';
  payload: {
    x: number;
    y: number;
    text: string;
  };
}

export type DebuggerInputOperation =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'click';
      x: number;
      y: number;
    };

export interface DebuggerInputSequenceRequest {
  type: 'DEBUGGER_INPUT_SEQUENCE';
  payload: {
    x: number;
    y: number;
    operations: DebuggerInputOperation[];
  };
}

export type BackgroundRequest =
  | ParseExcelRequest
  | RunPreviewRequest
  | RunFillRequest
  | ExportSourcesRequest
  | StopRunRequest
  | GetStateRequest
  | SetFillOptionsRequest
  | ReportRunProgressRequest
  | MemoqDebuggerPrepareRequest
  | MemoqDebuggerWriteTextRequest
  | DebuggerWriteTextRequest
  | DebuggerInputSequenceRequest;

export interface ContentScanRequest {
  type: 'CONTENT_SCAN';
  payload: {
    runId: string;
    scanFromTop?: boolean;
    maxPasses?: number;
    maxSegments?: number;
  };
}

export interface ContentFillRequest {
  type: 'CONTENT_FILL';
  payload: {
    runId: string;
    entries: TranslationEntry[];
    fillOptions: FillOptions;
    plannedFillCount: number | null;
    scanFromTop?: boolean;
    maxPasses?: number;
    maxSegments?: number;
  };
}

export interface ContentStopRequest {
  type: 'CONTENT_STOP';
}

export type ContentRequest =
  | ContentScanRequest
  | ContentFillRequest
  | ContentStopRequest;

export type ApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };
