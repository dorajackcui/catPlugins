export interface RecentSyntheticFingerprint {
  fingerprint: string;
  pass: number;
}

export function hasRepeatedSyntheticSignature(
  previousSignature: string,
  nextSignature: string
): boolean {
  return previousSignature !== '' && previousSignature === nextSignature;
}

export function isRecentSyntheticDuplicate(
  previous: RecentSyntheticFingerprint | undefined,
  fingerprint: string,
  pass: number,
  passWindow = 2
): boolean {
  if (!previous) {
    return false;
  }

  return previous.fingerprint === fingerprint && pass - previous.pass <= passWindow;
}

export function shouldRescanAfterSegmentFill(
  segment: { platform: string },
  outcome: { filled: boolean }
): boolean {
  return (segment.platform === 'memoq' || segment.platform === 'phrase') && outcome.filled;
}

export function shouldStopScanBeforeNextScroll({
  scrollMode,
  isAtBottom,
  noNewSegmentsPasses,
  repeatedSyntheticSignaturePasses
}: {
  scrollMode?: 'native' | 'synthetic';
  isAtBottom: boolean;
  noNewSegmentsPasses: number;
  repeatedSyntheticSignaturePasses: number;
}): boolean {
  if (isAtBottom) {
    return true;
  }

  return (
    scrollMode === 'synthetic' &&
    (noNewSegmentsPasses >= 4 || repeatedSyntheticSignaturePasses >= 2)
  );
}
