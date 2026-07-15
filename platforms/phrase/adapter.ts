import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from '../../content/types.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { waitForNormalizedTextMatch } from '../../shared/utils.ts';
import { PhraseEditorWriter } from './editor-writer.ts';
import { PhraseRowReader } from './row-reader.ts';

export class PhraseAdapter {
  private readonly editorWriter: PhraseEditorWriter;
  private readonly rowReader: PhraseRowReader;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.editorWriter = new PhraseEditorWriter(helpers);
    this.rowReader = new PhraseRowReader(helpers);
  }

  findScrollContext(): ScrollContext | null {
    return this.rowReader.findScrollContext();
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    return this.rowReader.collectVisibleSegments(scrollContext);
  }

  getEditableValue(targetElement: EditableElement): string {
    return this.rowReader.getEditableValue(targetElement);
  }

  async fillSegment(
    segment: RuntimeSegment,
    value: string
  ): Promise<FillOutcome> {
    const target = segment.targetElement;

    if (target instanceof HTMLElement && target.matches('.twe_target')) {
      await this.editorWriter.activate(target);
      try {
        await this.editorWriter.write(
          target,
          value,
          segment.phraseUsesTagMarkup === true
        );
      } catch (error) {
        return {
          domId: segment.domId,
          filled: false,
          reason: `Unable to write Phrase target through trusted input: ${
            error instanceof Error ? error.message : 'Unknown error.'
          }`
        };
      }

      const confirmed = await this.editorWriter.waitForTextMatch(
        () => this.getEditableValue(target),
        value
      );
      return {
        domId: segment.domId,
        filled: confirmed,
        reason: confirmed
          ? undefined
          : 'Unable to confirm target update after writing.'
      };
    }

    this.helpers.setEditableValue(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    this.helpers.dispatchChange(target);
    this.helpers.dispatchBlur(target);

    const confirmed = await waitForNormalizedTextMatch(
      () => this.getEditableValue(target),
      value,
      { attempts: 4, delayMs: 60 }
    );

    return {
      domId: segment.domId,
      filled: confirmed,
      reason: confirmed
        ? undefined
        : 'Unable to confirm target update after writing.'
    };
  }
}
