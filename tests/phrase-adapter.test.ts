import assert from 'node:assert/strict';
import test from 'node:test';

import { PhraseAdapter } from '../platforms/phrase/adapter.ts';

class FakeElement {
  tagName = 'DIV';
  id = '';
  textContent = '';
  children: FakeElement[] = [];
  events: string[] = [];

  constructor(
    public className: string,
    private readonly rect = { top: 20, left: 40, width: 200, height: 30 }
  ) {}

  get innerText(): string {
    return this.textContent;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .some((part) => part.trim() === '.twe_target' && this.className.includes('twe_target'));
  }

  querySelector<T extends Element = Element>(selector: string): T | null {
    if (selector.includes('input') || selector.includes('textarea') || selector.includes('contenteditable')) {
      return null;
    }

    if (selector.includes('.te_text_container')) {
      const textContainer = this.children.find((child) =>
        child.className.includes('te_text_container')
      );
      return textContainer ? (textContainer as unknown as T) : null;
    }

    return null;
  }

  closest(): null {
    return null;
  }

  focus(): void {
    this.events.push('focus');
  }

  dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return true;
  }

  getBoundingClientRect(): DOMRect {
    const { top, left, width, height } = this.rect;
    return {
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({})
    };
  }
}

class FakeInputElement extends FakeElement {
  tagName = 'INPUT';
  value = '';
  readOnly = false;
  disabled = false;

  constructor() {
    super('twe-main-input');
  }
}

class FakeTargetWithInput extends FakeElement {
  constructor(
    private readonly input: FakeInputElement,
    private readonly textContainer: FakeElement
  ) {
    super('flex-row twe_target twe_textarea_wrapper', {
      top: 100,
      left: 260,
      width: 140,
      height: 20
    });
  }

  override querySelector<T extends Element = Element>(selector: string): T | null {
    if (selector.includes('input.twe-main-input')) {
      return this.input as unknown as T;
    }

    if (selector.includes('.te_text_container')) {
      return this.textContainer as unknown as T;
    }

    return null;
  }
}

function installChromeRecorder(
  messages: unknown[],
  onMessage?: (message: unknown) => void
): () => void {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        messages.push(message);
        onMessage?.(message);
        callback({ ok: true, data: null });
      }
    }
  };

  return () => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
  };
}

test('PhraseAdapter.fillSegment uses trusted debugger text input when synthetic activation creates no live input', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];
  const calls: string[] = [];

  const target = new FakeElement('flex-row twe_target twe_textarea_wrapper', {
    top: 100,
    left: 260,
    width: 140,
    height: 20
  });
  const textContainer = new FakeElement('te_text_container');
  target.children = [textContainer];

  const restoreChrome = installChromeRecorder(messages, (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'DEBUGGER_WRITE_TEXT'
    ) {
      textContainer.textContent = String(
        (message as { payload?: { text?: string } }).payload?.text ?? ''
      );
    }
  });

  globalThis.HTMLElement = FakeElement as never;
  globalThis.HTMLInputElement = class FakeInputElement extends FakeElement {} as never;
  globalThis.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {} as never;
  globalThis.document = {
    body: {
      querySelector: () => null
    }
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new PhraseAdapter({
      dispatchMouseSequence: () => calls.push('synthetic-mouse'),
      readTextBySelectors: () => textContainer.textContent,
      setEditableValue: (element: FakeElement, value: string) => {
        calls.push(`direct-write:${element.className}`);
        element.textContent = value;
      },
      dispatchInput: () => calls.push('input'),
      dispatchChange: () => calls.push('change'),
      dispatchBlur: () => calls.push('blur'),
      dispatchTabNavigation: () => calls.push('tab')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-1',
        sourceRaw: 'Linlin (Youth)',
        sourceNormalized: 'Linlin (Youth)',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: target as never,
        platform: 'phrase'
      },
      'Linlin (Jeunesse)'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.includes('direct-write:te_text_container'), false);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_WRITE_TEXT',
        payload: {
          x: 330,
          y: 110,
          text: 'Linlin (Jeunesse)'
        }
      }
    ]);
  } finally {
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLInputElement = previousHTMLInputElement;
    globalThis.HTMLTextAreaElement = previousHTMLTextAreaElement;
  }
});

test('PhraseAdapter.fillSegment uses trusted debugger text input even when synthetic activation exposes a live input', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];
  const calls: string[] = [];

  const textContainer = new FakeElement('te_text_container');
  const input = new FakeInputElement();
  const target = new FakeTargetWithInput(input, textContainer);

  const restoreChrome = installChromeRecorder(messages, (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'DEBUGGER_WRITE_TEXT'
    ) {
      textContainer.textContent = String(
        (message as { payload?: { text?: string } }).payload?.text ?? ''
      );
    }
  });

  globalThis.HTMLElement = FakeElement as never;
  globalThis.HTMLInputElement = FakeInputElement as never;
  globalThis.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {} as never;
  globalThis.document = {
    body: {
      querySelector: () => null
    }
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new PhraseAdapter({
      dispatchMouseSequence: () => calls.push('synthetic-mouse'),
      readTextBySelectors: () => textContainer.textContent,
      setEditableValue: (element: FakeElement, value: string) => {
        calls.push(`direct-write:${element.className}`);
        if (element instanceof FakeInputElement) {
          element.value = value;
        } else {
          element.textContent = value;
        }
      },
      dispatchInput: () => calls.push('input'),
      dispatchChange: () => calls.push('change'),
      dispatchBlur: () => calls.push('blur'),
      dispatchTabNavigation: () => calls.push('tab')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-1',
        sourceRaw: 'Linlin (Youth)',
        sourceNormalized: 'Linlin (Youth)',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: target as never,
        platform: 'phrase'
      },
      'Linlin (Jeunesse)'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.includes('direct-write:twe-main-input'), false);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_WRITE_TEXT',
        payload: {
          x: 330,
          y: 110,
          text: 'Linlin (Jeunesse)'
        }
      }
    ]);
  } finally {
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.HTMLElement = previousHTMLElement;
    globalThis.HTMLInputElement = previousHTMLInputElement;
    globalThis.HTMLTextAreaElement = previousHTMLTextAreaElement;
  }
});
