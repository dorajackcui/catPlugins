export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function waitForNormalizedTextMatch(
  readValue: () => string,
  expected: string,
  options?: {
    attempts?: number;
    delayMs?: number;
  }
): Promise<boolean> {
  const attempts = Math.max(1, options?.attempts ?? 8);
  const delayMs = Math.max(0, options?.delayMs ?? 120);
  const normalizedExpected = normalizeText(expected);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (normalizeText(readValue()) === normalizedExpected) {
      return true;
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  return false;
}
