const MEMOQ_URL_RE = /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/webpm\/webtrans\//;
const MEMSOURCE_JOB_URL_RE =
  /^https:\/\/cloud\.memsource\.com\/web\/job\/[^/]+\/translate(?:[/?#]|$)/;
const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;
const GIENTRANS_EDITOR_URL_RE =
  /^https:\/\/gentrans\.genplus\.cn\/#\/olEditor(?:[/?#]|$)/;

export function isSupportedEditorUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('https://app.phrase.com/editor/') ||
    MEMSOURCE_JOB_URL_RE.test(url) ||
    MEMOQ_URL_RE.test(url) ||
    GIENTRANS_EDITOR_URL_RE.test(url)
  );
}

export function isMemoqUrl(url?: string): boolean {
  return Boolean(url && MEMOQ_URL_RE.test(url));
}

export function isGientTransUrl(url?: string): boolean {
  return Boolean(url && GIENTRANS_EDITOR_URL_RE.test(url));
}

export function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
}
