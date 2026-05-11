import type { MemoqFillFailureCode, MemoqFillFailureDiagnostic } from './types.ts';
import { normalizeText } from './utils.ts';

const FAILURE_MESSAGES: Record<MemoqFillFailureCode, string> = {
  ROW_NOT_FOUND: 'Could not find the current row.',
  ROW_AMBIGUOUS: 'Current row identity is ambiguous.',
  SOURCE_MISMATCH: 'Source changed before writing.',
  TARGET_NOT_EMPTY: 'Target is no longer empty.',
  FOCUS_FAILED: 'Could not activate the memoQ target editor.',
  INPUT_FAILED: 'Trusted text input failed.',
  CONFIRM_TIMEOUT: 'memoQ did not confirm the written target.',
  SCROLL_STALLED: 'memoQ scrolling stopped before the run could continue.',
  UNKNOWN_MEMOQ_FILL_ERROR: 'memoQ fill failed unexpectedly.'
};

export function truncateMemoqDiagnosticValue(value: string, maxLength = 120): string {
  const normalized = normalizeText(value);
  const safeMaxLength = Math.max(0, Math.floor(maxLength));

  if (normalized.length <= safeMaxLength) {
    return normalized;
  }

  if (safeMaxLength <= 3) {
    return '.'.repeat(safeMaxLength);
  }

  return `${normalized.slice(0, safeMaxLength - 3)}...`;
}

export function describeMemoqFillDiagnostic(diagnostic: MemoqFillFailureDiagnostic): string {
  const rowLabel = diagnostic.rowNumber
    ? `row ${diagnostic.rowNumber}`
    : `segment ${diagnostic.domId}`;
  const message = FAILURE_MESSAGES[diagnostic.failureCode];
  const source = diagnostic.sourceBefore || diagnostic.segmentSource;

  return `Stopped at memoQ ${rowLabel}: ${message} Source="${truncateMemoqDiagnosticValue(source)}"`;
}
