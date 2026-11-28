import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from '../../content/types.ts';
import type { PhraseMarkerFillPlan } from '../../domain/phrase-marker-fill.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { waitForNormalizedTextMatch } from '../../shared/utils.ts';
import { PhraseEditorWriter } from './editor-writer.ts';
import { PhraseRowReader } from './row-reader.ts';

export class PhraseAdapter {
  private readonly editorWriter = new PhraseEditorWriter();
  private readonly rowReader: PhraseRowReader;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
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
    value: string,
    markerFillPlan?: PhraseMarkerFillPlan
  ): Promise<FillOutcome> {
    const target = segment.targetElement;

    let filled: boolean;
    if (segment.platform === 'phrase') {
      try {
        if (segment.phraseSourceMarkers?.length && !markerFillPlan) {
          throw new Error('Native Phrase markers require a validated translation.');
        }
        filled = await this.editorWriter.write({
          resolve: () => this.rowReader.resolveTarget(segment),
          read: (cell) => this.rowReader.readTarget(cell)
        }, value, markerFillPlan);
      } catch (error) {
        return {
          domId: segment.domId,
          filled: false,
          reason: `Unable to write Phrase target through trusted input: ${
            error instanceof Error ? error.message : 'Unknown error.'
          }`
        };
      }

    } else {
      this.helpers.setEditableValue(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      this.helpers.dispatchChange(target);
      this.helpers.dispatchBlur(target);
      filled = await waitForNormalizedTextMatch(
        () => this.getEditableValue(target),
        value,
        { attempts: 4, delayMs: 60 }
      );
    }

    return {
      domId: segment.domId,
      filled,
      reason: filled ? undefined : 'Unable to confirm target update after writing.'
    };
  }
}
