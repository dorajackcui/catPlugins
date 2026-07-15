import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { delay } from '../../shared/utils.ts';
import { describeGientTransText } from './diagnostics.ts';
import {
  containsMappedGientTransTag,
  gientransTextToEditorHtml
} from './editor-text.ts';
import {
  GientTransEditorWriter,
  type NativeWriteDiagnostic
} from './editor-writer.ts';
import { GientTransRowReader } from './row-reader.ts';

const DEBUG_PREFIX = '[Phrase Bulk Fill][GientTrans]';

export class GientTransAdapter {
  private fillDebugSequence = 0;
  private readonly editorWriter: GientTransEditorWriter;
  private readonly rowReader: GientTransRowReader;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.editorWriter = new GientTransEditorWriter(helpers, delay);
    this.rowReader = new GientTransRowReader(helpers);
  }

  isActive(): boolean {
    return this.rowReader.isActive();
  }

  findScrollContext(): ScrollContext | null {
    return this.rowReader.findScrollContext();
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    return this.rowReader.collectVisibleSegments(scrollContext);
  }

  getEditableValue(targetElement: HTMLElement): string {
    return this.rowReader.getEditableValue(targetElement);
  }

  async fillSegment(
    segment: RuntimeSegment,
    value: string
  ): Promise<FillOutcome> {
    const fillId = ++this.fillDebugSequence;
    const currentTarget = this.rowReader.findCurrentTargetBySegmentId(
      segment.domId
    );
    const target = currentTarget ?? (segment.targetElement as HTMLElement);
    this.debug('fill:start', {
      fillId,
      domId: segment.domId,
      rowNumber: segment.rowNumber ?? null,
      foundCurrentTarget: Boolean(currentTarget),
      source: describeGientTransText(segment.sourceRaw),
      translation: describeGientTransText(value),
      targetBefore: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetAttrs: describeTarget(target)
    });

    if (!this.editorWriter.isWritable(target)) {
      this.debug('fill:skip', {
        fillId,
        reason: 'target-not-writable',
        targetAttrs: describeTarget(target)
      });
      return {
        domId: segment.domId,
        filled: false,
        reason: 'GientTrans target editor is not writable.'
      };
    }

    this.editorWriter.activate(target);
    const tagHtmlByToken =
      this.rowReader.collectSourceTagHtmlByToken(target);
    const editorHtml = gientransTextToEditorHtml(value, tagHtmlByToken);
    const containsMappedTags = containsMappedGientTransTag(
      value,
      tagHtmlByToken
    );
    const shouldPreserveEditorHtml =
      value.includes('\u00A0') || containsMappedTags;
    const nativeWrite = this.editorWriter.writeBeforeInputPaste(
      target,
      value,
      editorHtml
    );
    let fallbackNativeWrite: NativeWriteDiagnostic;
    let nativeHtmlWrite: NativeWriteDiagnostic | null = null;
    if (nativeWrite.ok) {
      fallbackNativeWrite = nativeWrite;
    } else if (shouldPreserveEditorHtml) {
      fallbackNativeWrite = {
        method: 'skipped' as const,
        attempted: false,
        ok: false,
        reason: containsMappedTags
          ? 'gientrans-tag-html-path'
          : 'nbsp-preserve-html-path',
        before: describeGientTransText(this.getEditableValue(target))
      };
    } else {
      fallbackNativeWrite = this.editorWriter.writeText(target, value);
    }

    if (!fallbackNativeWrite.ok) {
      nativeHtmlWrite = this.editorWriter.writeHtml(
        target,
        value,
        editorHtml
      );
      if (nativeHtmlWrite.ok) {
        fallbackNativeWrite = nativeHtmlWrite;
      }
    }

    if (!fallbackNativeWrite.ok) {
      this.editorWriter.replaceWithHtml(target, editorHtml);
    }

    this.debug('fill:write', {
      fillId,
      nativeWrite,
      fallbackNativeWrite,
      nativeHtmlWrite,
      usedFallbackInnerHtml: !fallbackNativeWrite.ok,
      activeElementMatchesTarget: document.activeElement === target,
      targetAfterWrite: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0
    });

    this.helpers.dispatchInput(target, value);
    this.helpers.dispatchChange(target);
    await delay(20);
    this.helpers.dispatchBlur(target);

    const confirmed = await this.editorWriter.waitForTextMatch(target, value);

    this.debug('fill:complete', {
      fillId,
      confirmed,
      targetAfterEvents: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetEvents: 'input/change/blur-dispatched'
    });

    return {
      domId: segment.domId,
      filled: confirmed,
      reason: confirmed
        ? undefined
        : 'Unable to confirm target update after writing.'
    };
  }

  private debug(label: string, payload: Record<string, unknown>): void {
    console.info(DEBUG_PREFIX, label, payload);
  }
}

function describeTarget(target: HTMLElement): Record<string, unknown> {
  return {
    tagName: target.tagName,
    className: target.className,
    contenteditable: target.getAttribute('contenteditable'),
    isContentEditable: target.isContentEditable,
    editortype: target.getAttribute('editortype'),
    segid: target.getAttribute('segid')
  };
}
