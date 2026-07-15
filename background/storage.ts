import { normalizeFillOptions } from '../domain/fill-options.ts';
import { storageGet, storageSet } from '../shared/chrome-api.ts';
import { DEFAULT_RUN_STATE, normalizeRunState } from '../domain/run-state.ts';
import { STORAGE_KEYS } from '../shared/storage-keys.ts';
import type {
  FillOptions,
  PreviewResult,
  TranslationEntry,
  UploadMeta
} from '../shared/translation-types.ts';
import type { RunState, RuntimeState } from '../shared/state-types.ts';

type RawState = Partial<Record<(typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS], unknown>>;
export type RuntimeStateUpdate = Partial<RuntimeState>;

export async function readRuntimeState(): Promise<RuntimeState> {
  const stored = await storageGet<RawState>(Object.values(STORAGE_KEYS));

  return {
    translationEntries:
      (stored[STORAGE_KEYS.translationEntries] as TranslationEntry[] | undefined) ?? [],
    previewResult:
      (stored[STORAGE_KEYS.previewResult] as PreviewResult | null | undefined) ?? null,
    uploadMeta: (stored[STORAGE_KEYS.uploadMeta] as UploadMeta | null | undefined) ?? null,
    fillOptions: normalizeFillOptions(stored[STORAGE_KEYS.fillOptions] as FillOptions | undefined),
    runState: normalizeRunState(
      (stored[STORAGE_KEYS.runState] as Partial<RunState> | undefined) ?? DEFAULT_RUN_STATE
    )
  };
}

export async function writeRuntimeState(
  partial: RuntimeStateUpdate
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

  if ('fillOptions' in partial) {
    payload[STORAGE_KEYS.fillOptions] = normalizeFillOptions(partial.fillOptions);
  }

  if ('runState' in partial) {
    payload[STORAGE_KEYS.runState] = normalizeRunState(partial.runState);
  }

  await storageSet(payload);
}
