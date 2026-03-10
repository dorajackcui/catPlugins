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
