import { runtimeSendMessage } from '../../shared/chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation
} from '../../shared/message-types.ts';
import { delay, normalizeText } from '../../shared/utils.ts';
import {
  isEmptyPhraseCell,
  phraseTargetMatches,
  type PhraseCellContent,
  type PhraseMarkerFillPlan
} from '../../domain/phrase-marker-fill.ts';

const INSERT_TAG_BUTTON_FALLBACK = [
  'button[aria-label="Insert tag"]',
  'button[aria-label="插入标记"]',
  'button[title*="Insert tag"]',
  'button[title*="插入标记"]'
].join(', ');
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface ResolvedPhraseTarget {
  resolve(): HTMLElement | null;
  read(target: HTMLElement): PhraseCellContent | null;
}

type PhraseInputAction =
  | Extract<DebuggerInputOperation, { type: 'text' | 'phraseTag' }>
  | { type: 'insertNextTag' }
  | { type: 'repeatTag'; distance: number };

export interface PhraseEditorWriterServices {
  sendMessage(request: BackgroundRequest): Promise<ApiResponse<null>>;
  wait(delayMs: number): Promise<void>;
}

const DEFAULT_SERVICES: PhraseEditorWriterServices = {
  sendMessage: (request) =>
    runtimeSendMessage<BackgroundRequest, ApiResponse<null>>(request),
  wait: delay
};

/** Writes to the resolved native target and verifies the editor's resulting content. */
export class PhraseEditorWriter {
  constructor(private readonly services: PhraseEditorWriterServices = DEFAULT_SERVICES) {}

  async write(
    row: ResolvedPhraseTarget,
    text: string,
    plan?: PhraseMarkerFillPlan
  ): Promise<boolean> {
    const actions: PhraseInputAction[] = plan
      ? buildMarkerActions(plan)
      : [{ type: 'text', text }];

    await this.send({ type: 'DEBUGGER_PREPARE' });
    const target = await this.focusEmptyTarget(row);
    const ownsRow = () => row.resolve() === target;
    const parts = plan?.parts ?? [];
    for (const [index, action] of actions.entries()) {
      const valid = () => ownsRow() && (index !== 0 || isEmptyPhraseCell(row.read(target)));
      if (action.type === 'repeatTag') {
        const hasPrefix = (end: number) => {
          const prefix = parts.slice(0, end);
          return this.waitForTarget(() => {
            const actual = ownsRow() ? row.read(target) : null;
            return actual !== null && phraseTargetMatches(actual, prefix);
          });
        };
        if (!await hasPrefix(index)) throw new Error('Could not verify the native Phrase tag to copy.');
        await this.repeatTag(target, valid, action.distance);
        if (!await hasPrefix(index + 1)) throw new Error('Could not confirm the copied Phrase tag in the target.');
      } else if (action.type === 'insertNextTag') {
        const doc = target.ownerDocument;
        const button = doc.querySelector<HTMLElement>('button#tag') ??
          doc.querySelector<HTMLElement>(INSERT_TAG_BUTTON_FALLBACK);
        if (!button) throw new Error('Phrase insert tag button was not found.');
        const point = this.getHitPoint(button);
        await this.runFocused(target, valid, [{ type: 'click', ...point }], button);
      } else {
        await this.runFocused(target, valid, [action]);
      }
    }

    const expectedText = normalizeText(text);
    return this.waitForTarget(() => {
      const current = row.resolve();
      const actual = current && row.read(current);
      if (!actual) return false;
      return plan ? phraseTargetMatches(actual, parts)
        : actual.markers.length === 0 && normalizeText(actual.text) === expectedText;
    });
  }

  private async waitForTarget(matches: () => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (matches()) {
        return true;
      }

      if (attempt < 7) {
        await this.services.wait(120);
      }
    }

    return false;
  }

  private async focusEmptyTarget(row: ResolvedPhraseTarget): Promise<HTMLElement> {
    const resolveEmpty = () => {
      const target = row.resolve();
      if (!target || !isEmptyPhraseCell(row.read(target))) {
        throw new Error('The Phrase source row or empty target changed before input.');
      }
      return target;
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      resolveEmpty().scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      await this.services.wait(20);
      const target = resolveEmpty();
      await this.send({
        type: 'DEBUGGER_INPUT_SEQUENCE',
        payload: { ...this.getHitPoint(target), operations: [{ type: 'wait', milliseconds: 30 }] }
      });
      if (await this.waitForTarget(() => resolveEmpty() === target && this.getFocusedInput(target) !== null)) {
        return target;
      }
    }
    throw new Error('The requested Phrase target did not receive editing focus.');
  }

  private async runFocused(
    target: HTMLElement,
    valid: () => boolean,
    operations: DebuggerInputOperation[],
    button?: HTMLElement
  ): Promise<void> {
    const doc = target.ownerDocument;
    const input = this.requireFocusedInput(target, valid);
    let blocked = false;
    const guard = (event: Event) => {
      const recipient = event.target as Node | null;
      const expectedRecipient = event.type === 'mousedown' || event.type === 'click'
        ? button?.contains(recipient)
        : recipient === input;
      const keepsFocus = this.getFocusedInput(target) === input ||
        (event.type === 'click' && doc.activeElement === button);
      if (!blocked && valid() && keepsFocus && expectedRecipient) return;
      blocked = true;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = button ? ['mousedown', 'click'] : ['beforeinput', 'keydown'];
    for (const event of events) doc.addEventListener(event, guard, true);
    try {
      await this.send({
        type: 'DEBUGGER_INPUT_SEQUENCE',
        payload: { alreadyFocused: true, operations }
      });
      if (blocked) throw new Error('The active Phrase target changed at the moment of input.');
      this.requireFocusedInput(target, () => target.isConnected);
    } finally {
      for (const event of events) doc.removeEventListener(event, guard, true);
    }
  }

  private async repeatTag(target: HTMLElement, valid: () => boolean, distance: number): Promise<void> {
    const select: DebuggerInputOperation[] = distance ? [{ type: 'moveLeft', count: distance }] : [];
    select.push({ type: 'selectLeft' });
    await this.runFocused(target, valid, select);

    // Let the editor serialize its own selected chip without changing the system clipboard.
    const clipboardData = new DataTransfer();
    const input = this.requireFocusedInput(target, valid);
    input.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    if (clipboardData.types.length === 0) throw new Error('Phrase did not copy the selected native tag.');

    await this.runFocused(target, valid, [{ type: 'moveRight', count: distance + 1 }]);
    this.requireFocusedInput(target, valid).dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true
    }));
  }

  private getFocusedInput(target: HTMLElement): HTMLElement | null {
    const input = target.ownerDocument.activeElement;
    return input instanceof HTMLElement && target.contains(input) &&
      input.matches('input.twe-main-input') ? input : null;
  }

  private requireFocusedInput(target: HTMLElement, valid: () => boolean): HTMLElement {
    const input = this.getFocusedInput(target);
    if (!input || !valid()) throw new Error('The intended Phrase target no longer owns the editing focus.');
    return input;
  }

  private getHitPoint(element: HTMLElement): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0 ||
      !element.contains(element.ownerDocument.elementFromPoint(x, y))) {
      throw new Error('The intended Phrase input surface is covered or outside the viewport.');
    }
    return { x, y };
  }

  private async send(request: BackgroundRequest): Promise<void> {
    const response = await this.services.sendMessage(request);
    if (!response.ok) throw new Error(response.error);
  }
}

function buildMarkerActions(plan: PhraseMarkerFillPlan): PhraseInputAction[] {
  const remaining = [...plan.sourceMarkers];
  const caretAfterTag = new Map<string, number>();
  let caret = 0;
  return plan.parts.map((part) => {
    if (part.type === 'text') {
      caret += Array.from(GRAPHEMES.segment(part.value)).length;
      return { type: 'text', text: part.value };
    }

    const { id, token } = part.marker;
    const previous = caretAfterTag.get(token);
    caretAfterTag.set(token, ++caret);
    if (previous !== undefined) {
      const distance = caret - previous - 1;
      if (distance >= 10000) throw new Error(`The previous Phrase tag ${token} is too far away to copy safely.`);
      return { type: 'repeatTag', distance };
    }

    const index = remaining.findIndex((marker) => marker.token === token);
    if (index < 0) throw new Error(`Phrase source has no marker ${token}.`);
    remaining.splice(index, 1);
    if (index === 0) return { type: 'insertNextTag' };
    if (id <= 9 && token === `{${id}}`) return { type: 'phraseTag', id };
    throw new Error(`Phrase cannot insert ${token} out of source order with its numbered shortcut.`);
  });
}
