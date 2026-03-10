import { extractPlaceholderTokens } from './qa.ts';
import type { FillOutcome } from './types.ts';
import { delay, normalizeText } from './utils.ts';
import type {
  ContentScriptDomHelpers,
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';

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
const TARGET_ACTIVATION_SELECTORS = [
  '.twe_target .te_text_container',
  '.twe_target .te_textarea_container',
  '.twe_target'
];
const LIVE_INPUT_SELECTORS = [
  '.twe_target input.twe-main-input:not([readonly])',
  '.twe_target textarea:not([readonly])',
  '.twe_target [contenteditable="true"]',
  'input.twe-main-input:not([readonly])',
  'textarea:not([readonly])',
  '[contenteditable="true"]'
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
  constructor(private readonly helpers: ContentScriptDomHelpers) {}

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

    const editables = Array.from(
      document.querySelectorAll<EditableElement>(EDITABLE_SELECTORS.join(','))
    )
      .filter((element) => this.helpers.isEditableCandidate(element))
      .sort((left, right) => {
        return this.helpers.getAbsoluteTop(left, scrollContext) - this.helpers.getAbsoluteTop(right, scrollContext);
      });

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
      await this.activateTarget(target);
      const liveInput = this.findLiveInput(target);

      if (liveInput instanceof HTMLInputElement || liveInput instanceof HTMLTextAreaElement) {
        this.helpers.setNativeInputValue(liveInput, value);
        liveInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        liveInput.dispatchEvent(new Event('change', { bubbles: true }));
        liveInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
        liveInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
        liveInput.dispatchEvent(new Event('blur', { bubbles: true }));
      } else if (liveInput instanceof HTMLElement && liveInput.isContentEditable) {
        liveInput.textContent = value;
        liveInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        liveInput.dispatchEvent(new Event('change', { bubbles: true }));
        liveInput.dispatchEvent(new Event('blur', { bubbles: true }));
      } else {
        const textContainer =
          target.querySelector<HTMLElement>('.te_text_container') || target;
        textContainer.textContent = value;
        textContainer.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        textContainer.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await delay(80);
      const nextValue = this.getEditableValue(target);
      return {
        domId: segment.domId,
        filled: normalizeText(nextValue) === normalizeText(value),
        reason:
          normalizeText(nextValue) === normalizeText(value)
            ? undefined
            : 'Unable to confirm target update after writing.'
      };
    }

    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      this.helpers.setNativeInputValue(target, value);
    } else {
      target.textContent = value;
    }

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.dispatchEvent(new Event('blur', { bubbles: true }));

    return { domId: segment.domId, filled: true };
  }

  private collectRowSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTORS.join(',')))
      .filter((row) => this.helpers.isElementVisible(row))
      .sort((left, right) => {
        return this.helpers.getAbsoluteTop(left, scrollContext) - this.helpers.getAbsoluteTop(right, scrollContext);
      });

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
      platform: 'phrase'
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

  private async activateTarget(targetElement: HTMLElement): Promise<void> {
    const clickTarget =
      targetElement.querySelector<HTMLElement>(TARGET_ACTIVATION_SELECTORS.join(',')) ||
      targetElement;

    for (const eventName of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      clickTarget.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }

    clickTarget.focus();
    await delay(80);
  }

  private findLiveInput(targetElement: HTMLElement): EditableElement | null {
    const row = targetElement.closest<HTMLElement>(ROW_SELECTORS.join(','));
    const scopedRoots = [targetElement, row, document.body].filter(
      (value): value is HTMLElement => Boolean(value)
    );

    for (const root of scopedRoots) {
      for (const selector of LIVE_INPUT_SELECTORS) {
        const input = root.querySelector<EditableElement>(selector);
        if (!input) {
          continue;
        }

        if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
          if (!input.readOnly && !input.disabled) {
            return input;
          }
          continue;
        }

        if (input.isContentEditable) {
          return input;
        }
      }
    }

    return null;
  }
}

