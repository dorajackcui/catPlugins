import { extractPlaceholderTokens } from '../../domain/qa.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { normalizeText, waitForNormalizedTextMatch } from '../../shared/utils.ts';
import { PhraseEditorWriter } from './editor-writer.ts';
import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from '../../content/types.ts';

const ROW_SELECTORS = ['.segment-row[role="row"]', '.segment-row', '.twe_segment'];
const SOURCE_ROW_SELECTORS = [
  '.text-area-source-container .te_text_container',
  '.text-area-source-container .te_txt',
  '.twe_source .te_text_container',
  '.twe_source .te_txt'
];
const TARGET_ROW_SELECTORS = [
  '.twe_target .te_text_container',
  '.twe_target .te_txt'
];
const TAG_MARKUP_SCOPE_SELECTORS = [
  ...SOURCE_ROW_SELECTORS,
  ...TARGET_ROW_SELECTORS
];
const TAG_CHIP_SELECTORS = [
  '[contenteditable="false"]',
  'input[type="tag"]',
  '[class*="tag"]',
  '[class*="Tag"]',
  '[data-testid*="tag"]',
  '[data-testid*="Tag"]',
  '[data-test*="tag"]',
  '[data-test*="Tag"]',
  '[data-qa*="tag"]',
  '[data-qa*="Tag"]',
  '[aria-label*="tag"]',
  '[aria-label*="Tag"]',
  '[aria-label*="标记"]',
  '[title*="tag"]',
  '[title*="Tag"]',
  '[title*="标记"]'
];
const SOURCE_SELECTORS = [
  '[data-testid*="source"]',
  '[data-test*="source"]',
  '[data-qa*="source"]',
  '[class*="source"]',
  '[data-testid*="segment-source"]',
  '[class*="segment-source"]'
];
const CONTAINER_SELECTORS = [
  '[data-testid*="segment"]',
  '[data-testid*="row"]',
  '[data-qa*="segment"]',
  '[class*="segment"]',
  '[class*="editor-row"]'
];
const EDITABLE_SELECTORS = [
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-qa*="target"]'
];

export class PhraseAdapter {
  private readonly editorWriter: PhraseEditorWriter;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.editorWriter = new PhraseEditorWriter(helpers);
  }

  findScrollContext(): ScrollContext | null {
    const editables = Array.from(
      document.querySelectorAll<HTMLElement>(
        [...ROW_SELECTORS, ...EDITABLE_SELECTORS, '.twe_target'].join(',')
      )
    );
    const bestContainer = this.helpers.findBestScrollContainer(editables);
    return bestContainer ? this.helpers.toElementScrollContext(bestContainer) : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rowSegments = this.collectRowSegments(scrollContext);
    if (rowSegments.length > 0) {
      return rowSegments;
    }

    const editables = this.helpers.sortByVisualPosition(
      Array.from(document.querySelectorAll<EditableElement>(EDITABLE_SELECTORS.join(',')))
        .filter((element) => this.helpers.isEditableCandidate(element)),
      scrollContext
    );

    const segments: RuntimeSegment[] = [];

    for (const editable of editables) {
      const segment = this.extractGenericSegment(editable, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }

  getEditableValue(targetElement: EditableElement): string {
    if (targetElement instanceof HTMLElement && targetElement.matches('.twe_target')) {
      return this.helpers.readTextBySelectors(targetElement, TARGET_ROW_SELECTORS);
    }

    return this.helpers.getGenericEditableValue(targetElement);
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
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
        reason:
          confirmed
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
      reason: confirmed ? undefined : 'Unable to confirm target update after writing.'
    };
  }

  private collectRowSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTORS.join(',')))
        .filter((row) => this.helpers.isElementVisible(row)),
      scrollContext
    );

    const segments: RuntimeSegment[] = [];

    for (const row of rows) {
      const segment = this.extractRowSegment(row, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }

  private extractRowSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const targetElement = row.querySelector<HTMLElement>('.twe_target');
    if (!targetElement) {
      return null;
    }

    const sourceRaw = this.helpers.readTextBySelectors(row, SOURCE_ROW_SELECTORS);
    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.helpers.readTextBySelectors(row, TARGET_ROW_SELECTORS);
    const domId =
      row.id ||
      row.getAttribute('data-position') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement,
      platform: 'phrase',
      phraseUsesTagMarkup: this.hasPhraseTagMarkup(row)
    };
  }

  private extractGenericSegment(
    targetElement: EditableElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const container = this.helpers.findSegmentContainer(targetElement, CONTAINER_SELECTORS);
    const sourceRaw = this.helpers.findSourceText(container, targetElement, SOURCE_SELECTORS);
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetElement);
    const absoluteTop = this.helpers.getAbsoluteTop(targetElement, scrollContext);
    const domId = `${sourceNormalized}::${Math.round(absoluteTop)}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement,
      platform: 'generic'
    };
  }

  private hasPhraseTagMarkup(row: HTMLElement): boolean {
    const scopedRoots = Array.from(
      row.querySelectorAll<HTMLElement>(TAG_MARKUP_SCOPE_SELECTORS.join(','))
    );
    const roots = scopedRoots.length > 0 ? scopedRoots : [row];

    return roots.some((root) => this.hasVisibleTagChip(root));
  }

  private hasVisibleTagChip(root: HTMLElement): boolean {
    return Array.from(
      root.querySelectorAll<HTMLElement>(TAG_CHIP_SELECTORS.join(','))
    ).some((element) => this.helpers.isElementVisible(element));
  }
}
