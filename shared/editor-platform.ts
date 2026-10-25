export type EditorPlatform = 'memoq' | 'phrase' | 'gientrans';

export function normalizeEditorPlatform(value: unknown): EditorPlatform | null {
  return value === 'memoq' || value === 'phrase' || value === 'gientrans'
    ? value
    : null;
}

export function requireEditorPlatform(value: unknown): EditorPlatform {
  const platform = normalizeEditorPlatform(value);
  if (!platform) {
    throw new Error('Choose an editor platform before running Preview, Fill, or Export.');
  }
  return platform;
}
