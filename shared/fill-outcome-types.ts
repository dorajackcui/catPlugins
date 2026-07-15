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
  profileId?: 'legacy-webtrans' | 'modern-editor';
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
