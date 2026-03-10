import { storageGet, storageSet } from './chrome-api.ts';
import { STORAGE_KEYS } from './types.ts';
import type { PreviewResult, RuntimeState, TranslationEntry, UploadMeta } from './types.ts';

type RawState = Partial<Record<(typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS], unknown>>;

export async function readRuntimeState(): Promise<RuntimeState> {
  const stored = await storageGet<RawState>(Object.values(STORAGE_KEYS));

  return {
    translationEntries:
      (stored[STORAGE_KEYS.translationEntries] as TranslationEntry[] | undefined) ?? [],
    previewResult:
      (stored[STORAGE_KEYS.previewResult] as PreviewResult | null | undefined) ?? null,
    uploadMeta: (stored[STORAGE_KEYS.uploadMeta] as UploadMeta | null | undefined) ?? null
  };
}

export async function writeRuntimeState(
  partial: Partial<RuntimeState>
): Promise<void> {
  const payload: Record<string, unknown> = {};

  if ('translationEntries' in partial) {
    payload[STORAGE_KEYS.translationEntries] = partial.translationEntries ?? [];
  }

  if ('previewResult' in partial) {
    payload[STORAGE_KEYS.previewResult] = partial.previewResult ?? null;
  }

  if ('uploadMeta' in partial) {
    payload[STORAGE_KEYS.uploadMeta] = partial.uploadMeta ?? null;
  }

  await storageSet(payload);
}
