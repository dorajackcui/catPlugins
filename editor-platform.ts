export type EditorPlatform = 'memoq' | 'phrase';

const PHRASE_APP_URL_RE = /^https:\/\/app\.phrase\.com\/editor\//;
const MEMSOURCE_JOB_URL_RE =
  /^https:\/\/cloud\.memsource\.com\/web\/job\/[^/]+\/translate(?:[/?#]|$)/;
export const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;
export const MEMOQ_URL_RE =
  /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/(?:webpm\/)?webtrans\/[^?#]*(?:[?#]|$)/;

export function getEditorPlatformForUrl(url?: string): EditorPlatform | null {
  if (!url) {
    return null;
  }

  if (MEMOQ_URL_RE.test(url)) {
    return 'memoq';
  }

  if (
    PHRASE_APP_URL_RE.test(url) ||
    MEMSOURCE_JOB_URL_RE.test(url) ||
    MEMSOURCE_EDITOR_FRAME_URL_RE.test(url)
  ) {
    return 'phrase';
  }

  return null;
}

export function isSupportedEditorUrl(url?: string): boolean {
  return getEditorPlatformForUrl(url) !== null;
}

export function isMemoqUrl(url?: string): boolean {
  return getEditorPlatformForUrl(url) === 'memoq';
}

export function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
}

export function getPlatformDisplayName(platform: EditorPlatform | null): string {
  if (platform === 'memoq') {
    return 'memoQ';
  }

  if (platform === 'phrase') {
    return 'Phrase';
  }

  return 'supported editor';
}

export function resolvePagePlatform(
  url: string | undefined,
  hasMemoqEditorCells = false
): EditorPlatform {
  const urlPlatform = getEditorPlatformForUrl(url);
  if (urlPlatform) {
    return urlPlatform;
  }

  return hasMemoqEditorCells ? 'memoq' : 'phrase';
}
