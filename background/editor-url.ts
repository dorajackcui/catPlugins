const MEMSOURCE_EDITOR_FRAME_URL_RE =
  /^https:\/\/editor\.memsource\.com\/twe\/translation\/job\/[^/?#]+/;

export function isMemsourceEditorFrameUrl(url?: string): boolean {
  return Boolean(url && MEMSOURCE_EDITOR_FRAME_URL_RE.test(url));
}
