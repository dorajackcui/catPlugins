export interface TranslationEntry {
  rowIndex: number;
  rowNumber?: string;
  /** A numbered row from the editor export must stay on that row in memoQ. */
  matchMemoqRowOnly?: true;
  originalSource?: string;
  phraseExportedTarget?: PhraseExportedTarget;
  sourceRaw: string;
  sourceNormalized: string;
  targetRaw: string;
  occurrenceIndex: number;
}

export interface PhraseNativeMarker {
  id: number;
  token: string;
  label: string;
  /** UTF-16 offset of the original label in the serialized cell text. */
  offset: number;
}

export interface PhraseExportedTarget {
  text: string;
  markers: Array<Pick<PhraseNativeMarker, 'token' | 'offset'>>;
}

export interface PageSegment {
  domId: string;
  rowNumber?: string;
  sourceRaw: string;
  originalSource?: string;
  /** Native chips observed in a webTrans row that accepts explicit marker IDs. */
  memoqSourceMarkers?: string[];
  phraseSourceMarkers?: PhraseNativeMarker[];
  phraseTargetMarkers?: PhraseNativeMarker[];
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

export interface ParseExcelResult {
  entries: TranslationEntry[];
  meta: UploadMeta;
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
