import { runtimeSendMessage } from './chrome-api.ts';
import {
  normalizePhraseTagClipText,
  splitPhraseMarkup
} from './phrase-markup.ts';
import { extractPlaceholderTokens } from './qa.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation,
  FillOutcome
} from './types.ts';
import { delay, normalizeText, waitForNormalizedTextMatch } from './utils.ts';
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
const INSERT_TAG_BUTTON_SELECTORS = [
  'button[aria-label="插入标记"]',
  'button[aria-label="Insert tag"]',
  'button[title*="插入标记"]',
  'button[title*="Insert tag"]'
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
      await this.activateTarget(target);
      try {
        await this.dispatchPhraseWrite(target, value);
      } catch (error) {
        return {
          domId: segment.domId,
          filled: false,
          reason: `Unable to write Phrase target through trusted input: ${
            error instanceof Error ? error.message : 'Unknown error.'
          }`
        };
      }

      const confirmed = await this.waitForPhraseTextMatch(
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

    this.helpers.dispatchMouseSequence(clickTarget, ['mousedown', 'mouseup', 'click', 'dblclick']);
    clickTarget.focus();
    await delay(80);
  }

  private async dispatchTrustedTextWrite(targetElement: HTMLElement, text: string): Promise<void> {
    targetElement.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await delay(20);

    const rect = targetElement.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Phrase target cell is not visible enough to write.');
    }

    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'DEBUGGER_WRITE_TEXT',
      payload: {
        x,
        y,
        text
      }
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  private async dispatchPhraseWrite(targetElement: HTMLElement, text: string): Promise<void> {
    const operations = this.buildPhraseInputOperations(text);

    if (!operations.some((operation) => operation.type === 'click')) {
      await this.dispatchTrustedTextWrite(targetElement, text);
      return;
    }

    const rect = this.getVisibleRect(
      targetElement,
      'Phrase target cell is not visible enough to write.'
    );

    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'DEBUGGER_INPUT_SEQUENCE',
      payload: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        operations
      }
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }

  private buildPhraseInputOperations(text: string): DebuggerInputOperation[] {
    const parts = splitPhraseMarkup(text);
    if (!parts.some((part) => part.type === 'tag')) {
      return [
        {
          type: 'text',
          text
        }
      ];
    }

    const insertTagButton = this.findInsertTagButton();
    const rect = this.getVisibleRect(
      insertTagButton,
      'Phrase insert tag button is not visible enough to click.'
    );
    const insertTagClick: DebuggerInputOperation = {
      type: 'click',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };

    return parts.map((part) =>
      part.type === 'text'
        ? {
            type: 'text',
            text: part.value
          }
        : insertTagClick
    );
  }

  private findInsertTagButton(): HTMLElement {
    for (const selector of INSERT_TAG_BUTTON_SELECTORS) {
      const button = document.querySelector<HTMLElement>(selector);
      if (button && this.helpers.isElementVisible(button)) {
        return button;
      }
    }

    throw new Error('Phrase insert tag button was not found.');
  }

  private getVisibleRect(element: HTMLElement, errorMessage: string): DOMRect {
    element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();

    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      throw new Error(errorMessage);
    }

    return rect;
  }

  private async waitForPhraseTextMatch(
    readValue: () => string,
    expected: string
  ): Promise<boolean> {
    const normalizedExpected = normalizePhraseTagClipText(expected);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (normalizePhraseTagClipText(readValue()) === normalizedExpected) {
        return true;
      }

      if (attempt < 7) {
        await delay(120);
      }
    }

    return false;
  }
}
