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

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

