import type { PageSegment, TranslationEntry } from '../shared/translation-types.ts';

type EntryIndex = Map<string, TranslationEntry | null>;

export class PhraseSourceLookup {
  private readonly numbered: EntryIndex = new Map();
  private readonly original: EntryIndex = new Map();

  constructor(entries: readonly TranslationEntry[]) {
    for (const entry of entries) {
      if (entry.rowNumber) {
        add(this.numbered, rowKey(entry.rowNumber, entry.sourceNormalized), entry);
      } else {
        add(this.original, entry.sourceNormalized, entry);
      }
    }
  }

  find(segment: PageSegment): TranslationEntry | null | undefined {
    const { rowNumber, sourceNormalized } = segment;
    const numbered = rowNumber ? this.numbered.get(rowKey(rowNumber, sourceNormalized)) : undefined;
    if (numbered !== undefined) return numbered;

    return this.original.get(sourceNormalized);
  }
}

function add(index: EntryIndex, key: string, entry: TranslationEntry): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, entry);
  else if (existing && (existing.targetRaw !== entry.targetRaw ||
    markerKey(existing) !== markerKey(entry))) index.set(key, null);
}

function markerKey(entry: TranslationEntry): string | undefined {
  const target = entry.phraseExportedTarget;
  return target?.text === entry.targetRaw ? JSON.stringify(target.markers) : undefined;
}

function rowKey(rowNumber: string, source: string): string {
  return `${rowNumber}:${source}`;
}
