import type { FillRunResult, PreviewResult } from '../shared/translation-types.ts';

export interface FillFailureSegment {
  platform?: string;
  domId: string;
  rowNumber?: string;
  sourceRaw: string;
}

export interface FillFailureOutcome {
  reason?: string;
}

export function shouldStopAfterFillFailure(platform?: string): boolean {
  return platform === 'memoq' || platform === 'phrase';
}

export function describeFillResult(result: FillRunResult): string {
  if (result.stopReason) return result.stopReason;
  return result.stoppedByAutoStop && result.autoStopAfterFilledCount !== null
    ? `Filled ${result.filledCount} segment(s) and auto-stopped at ${result.autoStopAfterFilledCount}.`
    : `Filled ${result.filledCount} segment(s).`;
}

export function includeEditorTagErrors(message: string, preview: PreviewResult | null): string {
  if (!preview?.placeholderErrors || !message.startsWith('Filled ')) return message;
  const skipped = preview.items.filter(item => item.status === 'placeholderError' &&
    (item.platform === 'memoq' || item.platform === 'phrase'));
  const first = skipped[0];
  if (!first) return message;
  const row = first.rowNumber ?? first.domId;
  const count = skipped.length === 1 ? '1 row' : `${skipped.length} rows`;
  return `${message} Skipped ${count} with tag errors. Row ${row}. ${first.reason ?? ''}`.trim();
}

export function describeFillStopReason(
  segment: FillFailureSegment,
  outcome: FillFailureOutcome
): string {
  const platformLabel = segment.platform === 'memoq' ? 'memoQ' : 'Phrase';
  const rowLabel = segment.rowNumber
    ? `row ${segment.rowNumber}`
    : `segment ${segment.domId}`;
  const sourcePreview =
    segment.sourceRaw.length > 80
      ? `${segment.sourceRaw.slice(0, 77)}...`
      : segment.sourceRaw;
  const reason = outcome.reason ?? `${platformLabel} fill could not be confirmed.`;

  return `Stopped at ${platformLabel} ${rowLabel}: ${reason} Source="${sourcePreview}"`;
}
