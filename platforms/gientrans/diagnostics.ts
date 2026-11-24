import { normalizeText } from '../../shared/utils.ts';
import { normalizeGientTransEditorText } from './editor-text.ts';

export interface GientTransTextDescription {
  rawLength: number;
  normalizedLength: number;
  normalized: string;
  preview: string;
}

export function describeGientTransText(
  value: string
): GientTransTextDescription {
  const normalized = normalizeText(normalizeGientTransEditorText(value));
  return {
    rawLength: value.length,
    normalizedLength: normalized.length,
    normalized,
    preview:
      normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
  };
}

export function logGientTrans(label: string, payload: Record<string, unknown>): void {
  console.info('[Phrase Bulk Fill][GientTrans]', label, payload);
}

export function describeGientTransTarget(target: HTMLElement): Record<string, unknown> {
  return {
    tagName: target.tagName,
    className: target.className,
    contenteditable: target.getAttribute('contenteditable'),
    isContentEditable: target.isContentEditable,
    editortype: target.getAttribute('editortype'),
    segid: target.getAttribute('segid')
  };
}
