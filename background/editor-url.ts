const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;

export function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
}

export function isGientTransEditorFrameUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const { hash, pathname } = new URL(url);
    return /^#\/olEditor\/?(?:\?|$)/i.test(hash) || /\/olEditor\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

export function isMemoqWebTransFrameUrl(url?: string): boolean {
  if (!url) return false;
  try { return /\/webtrans\/translation\.aspx$/i.test(new URL(url).pathname); }
  catch { return false; }
}
