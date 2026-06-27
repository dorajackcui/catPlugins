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
