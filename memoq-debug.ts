export type MemoqDiagnosticStage =
  | 'platform'
  | 'tab-check'
  | 'script-inject'
  | 'frame-resolve'
  | 'content-request'
  | 'scan'
  | 'scroll-context'
  | 'navigate'
  | 'activate-target'
  | 'editor-resolve'
  | 'write'
  | 'confirm';

export type MemoqDiagnosticLevel = 'info' | 'warn' | 'error';

export interface MemoqDiagnostics {
  info(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void;
  warn(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void;
  error(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void;
  summary(stage: MemoqDiagnosticStage, message: string): void;
}

export interface MemoqDiagnosticContext {
  runId?: string | null;
  scope?: 'background' | 'content';
}

export const NOOP_MEMOQ_DIAGNOSTICS: MemoqDiagnostics = {
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
  error() {
    // no-op
  },
  summary() {
    // no-op
  }
};

export function buildMemoqFailureSummary(
  stage: MemoqDiagnosticStage,
  message: string
): string {
  return `memoQ ${stage}: ${message}`;
}

export function logMemoqDiagnostic(
  context: MemoqDiagnosticContext,
  stage: MemoqDiagnosticStage,
  message: string,
  details?: Record<string, unknown>,
  level: MemoqDiagnosticLevel = 'info'
): void {
  const prefix = `[memoQ][${context.scope ?? 'content'}][${context.runId ?? '-'}][${stage}] ${message}`;
  const writer =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;

  if (details && Object.keys(details).length > 0) {
    writer(prefix, details);
    return;
  }

  writer(prefix);
}
