import { runtimeSendMessage } from '../../shared/chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation
} from '../../shared/types.ts';
import { delay } from '../../shared/utils.ts';
import { normalizePhraseTagClipText, splitPhraseMarkup } from './markup.ts';

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

export interface PhraseEditorWriterHelpers {
  dispatchMouseSequence(target: HTMLElement, eventNames: string[]): void;
  isElementVisible(element: Element): boolean;
}

export interface PhraseEditorWriterServices {
  sendMessage(request: BackgroundRequest): Promise<ApiResponse<null>>;
  wait(delayMs: number): Promise<void>;
}

const DEFAULT_SERVICES: PhraseEditorWriterServices = {
  sendMessage: (request) =>
    runtimeSendMessage<BackgroundRequest, ApiResponse<null>>(request),
  wait: delay
};

/**
 * Owns Phrase's trusted-input mechanics and tag-button click sequences.
 * Segment discovery and generic editable handling remain in the adapter.
 */
export class PhraseEditorWriter {
  constructor(
    private readonly helpers: PhraseEditorWriterHelpers,
    private readonly services: PhraseEditorWriterServices = DEFAULT_SERVICES
  ) {}

  async activate(targetElement: HTMLElement): Promise<void> {
    const clickTarget =
      targetElement.querySelector<HTMLElement>(TARGET_ACTIVATION_SELECTORS.join(',')) ||
      targetElement;

    this.helpers.dispatchMouseSequence(clickTarget, ['mousedown', 'mouseup', 'click', 'dblclick']);
    clickTarget.focus();
    await this.services.wait(80);
  }

  async write(
    targetElement: HTMLElement,
    text: string,
    useTagInsertion: boolean
  ): Promise<void> {
    const operations: DebuggerInputOperation[] = useTagInsertion
      ? this.buildInputOperations(text)
      : [
          {
            type: 'text',
            text
          }
        ];

    if (!operations.some((operation) => operation.type === 'click')) {
      await this.writeText(targetElement, text);
      return;
    }

    const rect = this.getVisibleRect(
      targetElement,
      'Phrase target cell is not visible enough to write.'
    );

    const response = await this.services.sendMessage({
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

  async waitForTextMatch(
    readValue: () => string,
    expected: string
  ): Promise<boolean> {
    const normalizedExpected = normalizePhraseTagClipText(expected);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (normalizePhraseTagClipText(readValue()) === normalizedExpected) {
        return true;
      }

      if (attempt < 7) {
        await this.services.wait(120);
      }
    }

    return false;
  }

  private async writeText(targetElement: HTMLElement, text: string): Promise<void> {
    targetElement.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await this.services.wait(20);

    const rect = targetElement.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Phrase target cell is not visible enough to write.');
    }

    const response = await this.services.sendMessage({
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

  private buildInputOperations(text: string): DebuggerInputOperation[] {
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
}
