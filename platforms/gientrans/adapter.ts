import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { delay } from '../../shared/utils.ts';
import { describeGientTransTarget, describeGientTransText, logGientTrans } from './diagnostics.ts';
import { tagIdentitiesFromEditorHtml } from './editor-tags.ts';
import { prepareGientTransTarget } from './editor-text.ts';
import { GientTransEditorWriter } from './editor-writer.ts';
import { GientTransRowReader } from './row-reader.ts';

export class GientTransAdapter {
  private fillDebugSequence = 0;
  private readonly editorWriter: GientTransEditorWriter;
  private readonly rowReader: GientTransRowReader;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.editorWriter = new GientTransEditorWriter(helpers, delay);
    this.rowReader = new GientTransRowReader(helpers);
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
    logGientTrans('fill:start', {
      fillId,
      domId: segment.domId,
      rowNumber: segment.rowNumber ?? null,
      foundCurrentTarget: Boolean(currentTarget),
      source: describeGientTransText(segment.sourceRaw),
      translation: describeGientTransText(value),
      targetBefore: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetAttrs: describeGientTransTarget(target)
    });

    if (!this.editorWriter.isWritable(target)) {
      logGientTrans('fill:skip', {
        fillId,
        reason: 'target-not-writable',
        targetAttrs: describeGientTransTarget(target)
      });
      return {
        domId: segment.domId,
        filled: false,
        reason: 'GientTrans target editor is not writable.'
      };
    }

    this.editorWriter.activate(target);
    const sourceTags = this.rowReader.collectSourceTags(target);
    const { text, html } = prepareGientTransTarget(value, sourceTags);
    const expectedTags = sourceTags.byToken.size ? tagIdentitiesFromEditorHtml(html) : undefined;
    const write = this.editorWriter.write(target, text, html, expectedTags);

    logGientTrans('fill:write', {
      fillId,
      removedTrailingLineWhitespace: text !== value,
      ...write,
      activeElementMatchesTarget: document.activeElement === target,
      targetAfterWrite: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0
    });

    this.helpers.dispatchInput(target, text);
    this.helpers.dispatchChange(target);
    await delay(20);
    this.helpers.dispatchBlur(target);

    const confirmed = await this.editorWriter.waitForTextMatch(
      target,
      text,
      expectedTags
    );

    logGientTrans('fill:complete', {
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
}
