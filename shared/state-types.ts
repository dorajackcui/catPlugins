import type {
  FillOptions,
  PreviewResult,
  TranslationEntry,
  UploadMeta
} from './translation-types.ts';

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

export interface PopupState {
  uploadMeta: UploadMeta | null;
  previewResult: PreviewResult | null;
  fillOptions: FillOptions;
  runState: RunState;
}
