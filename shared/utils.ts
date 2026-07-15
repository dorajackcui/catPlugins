export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

// U+00A0 no-break space, U+202F narrow no-break space (French punctuation spacing).
const NO_BREAK_SPACE_CHARS = String.fromCharCode(0x00a0, 0x202f);
const NO_BREAK_SPACE_PATTERN = new RegExp(`[${NO_BREAK_SPACE_CHARS}]`);
const COLLAPSIBLE_WHITESPACE_PATTERN = new RegExp(`[^\\S${NO_BREAK_SPACE_CHARS}]+`, 'g');

export function containsNoBreakSpace(value: string): boolean {
  return NO_BREAK_SPACE_PATTERN.test(value);
}

export function normalizeTextPreservingNoBreakSpaces(value: string): string {
  return value
    .replace(COLLAPSIBLE_WHITESPACE_PATTERN, ' ')
    .replace(/^ +| +$/g, '');
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
