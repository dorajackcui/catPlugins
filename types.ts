export interface TranslationEntry {
  rowIndex: number;
  rowNumber?: string;
  sourceRaw: string;
  sourceNormalized: string;
  targetRaw: string;
  occurrenceIndex: number;
}

export interface PageSegment {
  domId: string;
  rowNumber?: string;
  sourceRaw: string;
  sourceNormalized: string;
  occurrenceIndex: number;
  targetRaw: string;
  isEmptyTarget: boolean;
  placeholderTokens: string[];
  platform?: 'memoq' | 'gientrans' | 'phrase' | 'generic';
}

export type PreviewItemStatus =
  | 'unmatched'
  | 'alreadyTranslated'
  | 'placeholderError'
  | 'ready';

export interface PreviewItem extends PageSegment {
  status: PreviewItemStatus;
  translation?: string;
  excelRowIndex?: number;
  reason?: string;
}

export interface PreviewResult {
  totalSegments: number;
  matched: number;
  alreadyTranslated: number;
  placeholderErrors: number;
  readyToFill: number;
  skipped: number;
  items: PreviewItem[];
  generatedAt: string;
}

export interface UploadMeta {
  fileName: string;
  entryCount: number;
  uploadedAt: string;
  sheetName: string;
}

export interface FillOptions {
  autoStopAfterFilledCount: number | null;
  validatePlaceholders: boolean;
}

export type RunKind = 'preview' | 'fill' | 'export';

export type RunPhase = 'idle' | 'running' | 'stopping';

export type StatusKind = 'default' | 'error';

export interface RunState {
  runId: string | null;
  kind: RunKind | null;
  phase: RunPhase;
  statusKind: StatusKind;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  tabId: number | null;
  frameId: number | null;
  plannedFillCount: number | null;
  scannedCount: number;
  filledCount: number;
  message: string;
}

export interface RuntimeState {
  translationEntries: TranslationEntry[];
  previewResult: PreviewResult | null;
  uploadMeta: UploadMeta | null;
  fillOptions: FillOptions;
  runState: RunState;
}

export interface ParseExcelResult {
  entries: TranslationEntry[];
  meta: UploadMeta;
}

export interface PopupState {
  uploadMeta: UploadMeta | null;
  previewResult: PreviewResult | null;
  fillOptions: FillOptions;
  runState: RunState;
}

export interface FillRunResult {
  preview: PreviewResult;
  filledCount: number;
  filledDomIds: string[];
  stoppedByAutoStop: boolean;
  autoStopAfterFilledCount: number | null;
  stopReason?: string;
}

export interface ExportSourcesResult {
  fileName: string;
  bytes: number[];
  segmentCount: number;
}

export type MemoqFillFailureCode =
  | 'ROW_NOT_FOUND'
  | 'ROW_AMBIGUOUS'
  | 'SOURCE_MISMATCH'
  | 'TARGET_NOT_EMPTY'
  | 'FOCUS_FAILED'
  | 'INPUT_FAILED'
  | 'CONFIRM_TIMEOUT'
  | 'SCROLL_STALLED'
  | 'UNKNOWN_MEMOQ_FILL_ERROR';

export interface MemoqVisibleRowSnapshot {
  rowNumber?: string;
  source: string;
  target: string;
}

export interface MemoqFillDiagnosticBase {
  runId: string;
  sequence: number;
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
  domId: string;
  rowNumber?: string;
  locatingMethod: 'rowNumber' | 'singleVisibleSource' | 'none';
  segmentSource: string;
  sourceBefore: string;
  targetBefore: string;
  expectedTranslation: string;
  activation: {
    attempted: boolean;
    ok: boolean;
    activeElement?: string;
    error?: string;
  };
  inputMethod: 'chrome-debugger';
  targetAfter: string;
  confirmation: {
    ok: boolean;
    attempts: number;
  };
  nearbyRows: MemoqVisibleRowSnapshot[];
}

export type MemoqFillSuccessDiagnostic = MemoqFillDiagnosticBase & {
  outcome: 'success';
  failureCode?: never;
};

export type MemoqFillFailureDiagnostic = MemoqFillDiagnosticBase & {
  outcome: 'failure';
  failureCode: MemoqFillFailureCode;
};

export type MemoqFillDiagnostic =
  | MemoqFillSuccessDiagnostic
  | MemoqFillFailureDiagnostic;

export interface FillOutcomeBase {
  domId: string;
  reason?: string;
}

export type FillOutcome =
  | (FillOutcomeBase & {
      filled: true;
      diagnostic?: MemoqFillSuccessDiagnostic;
    })
  | (FillOutcomeBase & {
      filled: false;
      diagnostic?: MemoqFillFailureDiagnostic;
    });

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

export interface MemoqDebuggerClickRequest {
  type: 'MEMOQ_DEBUGGER_CLICK';
  payload: {
    x: number;
    y: number;
  };
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

export type BackgroundRequest =
  | ParseExcelRequest
  | RunPreviewRequest
  | RunFillRequest
  | ExportSourcesRequest
  | StopRunRequest
  | GetStateRequest
  | SetFillOptionsRequest
  | ReportRunProgressRequest
  | MemoqDebuggerClickRequest
  | MemoqDebuggerWriteTextRequest
  | DebuggerWriteTextRequest;

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

export const STORAGE_KEYS = {
  translationEntries: 'translation_entries',
  previewResult: 'preview_result',
  uploadMeta: 'upload_meta',
  fillOptions: 'fill_options',
  runState: 'run_state'
} as const;
