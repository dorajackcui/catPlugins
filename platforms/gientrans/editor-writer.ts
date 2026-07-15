import { normalizeText } from '../../utils.ts';
import {
  normalizeGientTransEditorText,
  readGientTransEditorText,
  readGientTransEditorTextPreservingNbsp,
  stripEditorMarkers
} from './editor-text.ts';
import { normalizeGientTransInlineMarkup } from './markup.ts';

export interface NativeWriteDiagnostic {
  method: 'beforeinput-paste' | 'insertText' | 'insertHTML' | 'skipped';
  attempted: boolean;
  ok: boolean;
  reason?: string;
  dispatchResult?: boolean;
  defaultPrevented?: boolean;
  execResult?: boolean;
  selected?: boolean;
  before?: ReturnType<typeof describeGientTransText>;
  after?: ReturnType<typeof describeGientTransText>;
}

export interface GientTransEditorWriterHelpers {
  dispatchMouseSequence(target: HTMLElement, eventNames: string[]): void;
}

/**
 * Encapsulates GientTrans's contenteditable mechanics. The adapter retains
 * control over fallback ordering and editor lifecycle events.
 */
export class GientTransEditorWriter {
  constructor(
    private readonly helpers: GientTransEditorWriterHelpers,
    private readonly wait: (delayMs: number) => Promise<void>
  ) {}

  isWritable(target: HTMLElement): boolean {
    return target.isContentEditable || target.getAttribute('contenteditable') === 'true';
  }

  activate(target: HTMLElement): void {
    const cell = target.closest<HTMLElement>('td.target-cell') ?? target;
    this.helpers.dispatchMouseSequence(cell, ['mousedown', 'mouseup', 'click', 'dblclick']);
    target.focus();
  }

  writeText(target: HTMLElement, value: string): NativeWriteDiagnostic {
    const before = describeGientTransText(readGientTransEditorText(target));
    if (typeof document.execCommand !== 'function') {
      return {
        method: 'insertText',
        attempted: false,
        ok: false,
        reason: 'execCommand-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    let execResult = false;

    try {
      execResult = document.execCommand('insertText', false, value);
    } catch (error) {
      return {
        method: 'insertText',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'execCommand-threw',
        selected,
        before,
        after: describeGientTransText(readGientTransEditorText(target))
      };
    }

    const after = describeGientTransText(readGientTransEditorText(target));
    return {
      method: 'insertText',
      attempted: true,
      ok: after.normalized === normalizeText(value),
      execResult,
      selected,
      before,
      after
    };
  }

  writeHtml(
    target: HTMLElement,
    value: string,
    editorHtml: string
  ): NativeWriteDiagnostic {
    const before = describeGientTransText(readGientTransEditorText(target));
    if (typeof document.execCommand !== 'function') {
      return {
        method: 'insertHTML',
        attempted: false,
        ok: false,
        reason: 'execCommand-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    let execResult = false;

    try {
      execResult = document.execCommand('insertHTML', false, editorHtml);
    } catch (error) {
      return {
        method: 'insertHTML',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'execCommand-threw',
        selected,
        before,
        after: describeGientTransText(readGientTransEditorText(target))
      };
    }

    return {
      method: 'insertHTML',
      attempted: true,
      ok: this.isTextMatch(target, value),
      execResult,
      selected,
      before,
      after: describeGientTransText(readGientTransEditorText(target))
    };
  }

  writeBeforeInputPaste(
    target: HTMLElement,
    value: string,
    editorHtml: string
  ): NativeWriteDiagnostic {
    const before = describeGientTransText(readGientTransEditorText(target));
    if (typeof InputEvent !== 'function' || typeof DataTransfer !== 'function') {
      return {
        method: 'beforeinput-paste',
        attempted: false,
        ok: false,
        reason: 'beforeinput-paste-unavailable',
        before
      };
    }

    const selected = this.selectTargetContents(target);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', value);
    dataTransfer.setData('text/segment', editorHtml);
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertFromPaste'
    });

    try {
      Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: dataTransfer
      });
    } catch {
      return {
        method: 'beforeinput-paste',
        attempted: true,
        ok: false,
        reason: 'dataTransfer-unavailable',
        selected,
        before,
        after: describeGientTransText(readGientTransEditorText(target))
      };
    }

    let dispatchResult = true;
    try {
      dispatchResult = target.dispatchEvent(event);
    } catch (error) {
      return {
        method: 'beforeinput-paste',
        attempted: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'beforeinput-paste-threw',
        selected,
        before,
        after: describeGientTransText(readGientTransEditorText(target))
      };
    }

    const after = describeGientTransText(readGientTransEditorText(target));
    return {
      method: 'beforeinput-paste',
      attempted: true,
      ok: this.isTextMatch(target, value),
      dispatchResult,
      defaultPrevented: event.defaultPrevented,
      selected,
      before,
      after
    };
  }

  replaceWithHtml(target: HTMLElement, editorHtml: string): void {
    target.innerHTML = editorHtml;
    this.collapseSelectionToEnd(target);
  }

  async waitForTextMatch(target: HTMLElement, expected: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.isTextMatch(target, expected)) {
        return true;
      }

      if (attempt < 5) {
        await this.wait(80);
      }
    }

    return false;
  }

  private selectTargetContents(target: HTMLElement): boolean {
    if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private collapseSelectionToEnd(target: HTMLElement): boolean {
    if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private isTextMatch(target: HTMLElement, expected: string): boolean {
    const normalizedExpected = normalizeGientTransInlineMarkup(stripEditorMarkers(expected));
    if (expected.includes('\u00A0')) {
      return (
        normalizeGientTransInlineMarkup(readGientTransEditorTextPreservingNbsp(target)) ===
        normalizedExpected
      );
    }

    return (
      normalizeText(normalizeGientTransInlineMarkup(readGientTransEditorText(target))) ===
      normalizeText(normalizedExpected)
    );
  }
}

export function describeGientTransText(value: string): {
  rawLength: number;
  normalizedLength: number;
  normalized: string;
  preview: string;
} {
  const normalized = normalizeText(normalizeGientTransEditorText(value));
  return {
    rawLength: value.length,
    normalizedLength: normalized.length,
    normalized,
    preview: normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
  };
}
