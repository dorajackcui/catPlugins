export interface TranslationEntry {
  rowIndex: number;
  sourceRaw: string;
  sourceNormalized: string;
  targetRaw: string;
  occurrenceIndex: number;
}

export interface PageSegment {
  domId: string;
  sourceRaw: string;
  sourceNormalized: string;
  occurrenceIndex: number;
  targetRaw: string;
  isEmptyTarget: boolean;
  placeholderTokens: string[];
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

export interface RuntimeState {
  translationEntries: TranslationEntry[];
  previewResult: PreviewResult | null;
  uploadMeta: UploadMeta | null;
}

export interface ParseExcelResult {
  entries: TranslationEntry[];
  meta: UploadMeta;
}

export interface PopupState {
  uploadMeta: UploadMeta | null;
  previewResult: PreviewResult | null;
}

export interface FillRunResult {
  preview: PreviewResult;
  filledCount: number;
  filledDomIds: string[];
}

export interface FillOutcome {
  domId: string;
  filled: boolean;
  reason?: string;
}

export interface ParseExcelRequest {
  type: 'PARSE_EXCEL';
  payload: {
    fileName: string;
    bytes: number[];
  };
}

export interface RunPreviewRequest {
  type: 'RUN_PREVIEW';
}

export interface RunFillRequest {
  type: 'RUN_FILL';
}

export interface GetStateRequest {
  type: 'GET_STATE';
}

export type BackgroundRequest =
  | ParseExcelRequest
  | RunPreviewRequest
  | RunFillRequest
  | GetStateRequest;

export interface ContentScanRequest {
  type: 'CONTENT_SCAN';
}

export interface ContentFillRequest {
  type: 'CONTENT_FILL';
  payload: {
    entries: TranslationEntry[];
  };
}

export type ContentRequest = ContentScanRequest | ContentFillRequest;

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
  uploadMeta: 'upload_meta'
} as const;
