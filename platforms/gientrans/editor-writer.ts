import {
  readGientTransEditorText,
  readGientTransEditorTextPreservingNbsp,
  stripEditorMarkers
} from './editor-text.ts';
import { normalizeGientTransEditorMarkup } from '../../domain/gientrans-markup.ts';
import { describeGientTransText } from './diagnostics.ts';
import { readGientTransTagIdentities } from './editor-tags.ts';

interface NativeWriteDiagnostic {
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
 * Writes to the active contenteditable and verifies both its text and native chips.
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

  write(target: HTMLElement, text: string, html: string, expectedTags?: readonly string[]) {
    const nativeWrite = this.writeBeforeInputPaste(target, text, html, expectedTags);
    let fallbackNativeWrite = nativeWrite;
    let nativeHtmlWrite: NativeWriteDiagnostic | null = null;

    if (!nativeWrite.ok) {
      // insertText cannot preserve native chips or a nonbreaking space.
      if (expectedTags?.length || text.includes('\u00A0')) {
        fallbackNativeWrite = {
          method: 'skipped', attempted: false, ok: false,
          reason: expectedTags?.length ? 'gientrans-tag-html-path' : 'nbsp-preserve-html-path',
          before: describeGientTransText(readGientTransEditorText(target))
        };
      } else {
        fallbackNativeWrite = this.writeCommand(target, 'insertText', text, text);
      }
    }
    if (!fallbackNativeWrite.ok) {
      nativeHtmlWrite = this.writeCommand(target, 'insertHTML', html, text, expectedTags);
      if (nativeHtmlWrite.ok) fallbackNativeWrite = nativeHtmlWrite;
    }
    const usedFallbackInnerHtml = !fallbackNativeWrite.ok;
    if (usedFallbackInnerHtml) {
      target.innerHTML = html;
      this.selectTarget(target, 'end');
    }
    return { nativeWrite, fallbackNativeWrite, nativeHtmlWrite, usedFallbackInnerHtml };
  }

  private writeCommand(
    target: HTMLElement,
    method: 'insertText' | 'insertHTML',
    content: string,
    expectedText: string,
    expectedTags?: readonly string[]
  ): NativeWriteDiagnostic {
    const before = describeGientTransText(readGientTransEditorText(target));
    if (typeof document.execCommand !== 'function') {
      return { method, attempted: false, ok: false, reason: 'execCommand-unavailable', before };
    }

    const selected = this.selectTarget(target, 'contents');
    let execResult: boolean;
    try {
      execResult = document.execCommand(method, false, content);
    } catch (error) {
      return {
        method, attempted: true, ok: false, selected, before,
        reason: error instanceof Error ? error.message : 'execCommand-threw',
        after: describeGientTransText(readGientTransEditorText(target))
      };
    }
    return {
      method, attempted: true, ok: this.isTextMatch(target, expectedText, expectedTags),
      execResult, selected, before,
      after: describeGientTransText(readGientTransEditorText(target))
    };
  }

  private writeBeforeInputPaste(
    target: HTMLElement,
    value: string,
    editorHtml: string,
    expectedTags?: readonly string[]
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

    const selected = this.selectTarget(target, 'contents');
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
      ok: this.isTextMatch(target, value, expectedTags),
      dispatchResult,
      defaultPrevented: event.defaultPrevented,
      selected,
      before,
      after
    };
  }

  async waitForTextMatch(
    target: HTMLElement,
    expected: string,
    expectedTags?: readonly string[]
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (this.isTextMatch(target, expected, expectedTags)) {
        return true;
      }

      if (attempt < 5) {
        await this.wait(80);
      }
    }

    return false;
  }

  private selectTarget(target: HTMLElement, position: 'contents' | 'end'): boolean {
    if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    const range = document.createRange();
    range.selectNodeContents(target);
    if (position === 'end') range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private isTextMatch(target: HTMLElement, expected: string, expectedTags?: readonly string[]): boolean {
    if (expectedTags) {
      const actualTags = readGientTransTagIdentities(target);
      if (actualTags.length !== expectedTags.length ||
          actualTags.some((tag, index) => tag !== expectedTags[index])) {
        return false;
      }
    }

    const actual = expected.includes('\u00A0')
      ? readGientTransEditorTextPreservingNbsp(target)
      : readGientTransEditorText(target);
    return normalizeGientTransEditorMarkup(normalizeLineEndings(actual)) ===
      normalizeGientTransEditorMarkup(normalizeLineEndings(stripEditorMarkers(expected)));
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}
