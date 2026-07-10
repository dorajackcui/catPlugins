import assert from 'node:assert/strict';
import test from 'node:test';

import { PhraseAdapter } from '../phrase-adapter.ts';

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

test('PhraseAdapter.fillSegment keeps plaintext tag tokens in trusted text input', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];

  const target = new FakeElement('flex-row twe_target twe_textarea_wrapper', {
    top: 100,
    left: 260,
    width: 140,
    height: 20
  });
  const textContainer = new FakeElement('te_text_container');
  target.children = [textContainer];
  const insertTagButton = new FakeElement('twe-toolbar-button', {
    top: 30,
    left: 20,
    width: 20,
    height: 20
  });

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
    querySelector: (selector: string) =>
      selector.includes('aria-label="插入标记"')
        ? insertTagButton
        : null,
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
      dispatchMouseSequence: () => undefined,
      readTextBySelectors: () => textContainer.textContent,
      isElementVisible: () => true,
      setEditableValue: () => undefined,
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchBlur: () => undefined,
      dispatchTabNavigation: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-plaintext-color',
        sourceRaw: '<color=#FFFFFF>Unlocks after <color=#EF{a}>{b} days</color>',
        sourceNormalized: '<color=#FFFFFF>Unlocks after <color=#EF{a}>{b} days</color>',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [
          '<color=#FFFFFF>',
          '<color=#EF{a}>',
          '{b}',
          '</color>'
        ],
        targetElement: target as never,
        platform: 'phrase'
      },
      '<color=#FFFFFF>Se débloque après <color=#EF{a}>{b} jours</color>'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_WRITE_TEXT',
        payload: {
          x: 330,
          y: 110,
          text: '<color=#FFFFFF>Se débloque après <color=#EF{a}>{b} jours</color>'
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

test('PhraseAdapter.fillSegment confirms Phrase tag clip echoes against plain placeholder text', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];

  const target = new FakeElement('flex-row twe_target twe_textarea_wrapper', {
    top: 100,
    left: 260,
    width: 140,
    height: 20
  });
  const textContainer = new FakeElement('te_text_container');
  target.children = [textContainer];
  const insertTagButton = new FakeElement('twe-toolbar-button', {
    top: 30,
    left: 20,
    width: 20,
    height: 20
  });

  const restoreChrome = installChromeRecorder(messages, (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'DEBUGGER_INPUT_SEQUENCE'
    ) {
      textContainer.textContent = '有効範囲が1{1}m増加する。';
    }
  });

  globalThis.HTMLElement = FakeElement as never;
  globalThis.HTMLInputElement = FakeInputElement as never;
  globalThis.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {} as never;
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.includes('aria-label="插入标记"')
        ? insertTagButton
        : null,
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
      dispatchMouseSequence: () => undefined,
      readTextBySelectors: () => textContainer.textContent,
      isElementVisible: () => true,
      setEditableValue: () => undefined,
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchBlur: () => undefined,
      dispatchTabNavigation: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-2960',
        sourceRaw: '奋力争抢生效范围增加1{1}米。',
        sourceNormalized: '奋力争抢生效范围增加1{1}米。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1}'],
        targetElement: target as never,
        platform: 'phrase',
        phraseUsesTagMarkup: true
      },
      '有効範囲が{1}m増加する。'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_INPUT_SEQUENCE',
        payload: {
          x: 330,
          y: 110,
          operations: [
            {
              type: 'text',
              text: '有効範囲が'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'm増加する。'
            }
          ]
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

test('PhraseAdapter.fillSegment confirms Phrase numbered color tag clip echoes against plain XML-like text', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];

  const target = new FakeElement('flex-row twe_target twe_textarea_wrapper', {
    top: 100,
    left: 260,
    width: 140,
    height: 20
  });
  const textContainer = new FakeElement('te_text_container');
  target.children = [textContainer];
  const insertTagButton = new FakeElement('twe-toolbar-button', {
    top: 30,
    left: 20,
    width: 20,
    height: 20
  });

  const restoreChrome = installChromeRecorder(messages, (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'DEBUGGER_INPUT_SEQUENCE'
    ) {
      textContainer.textContent =
        'ブラッド・ミラーが1<color=#fa7000>ポストターン後2</color>、ターンの勢いを利用して素早くフック3<color=#fa7000>シュート4</color>を決める。';
    }
  });

  globalThis.HTMLElement = FakeElement as never;
  globalThis.HTMLInputElement = FakeInputElement as never;
  globalThis.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {} as never;
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.includes('aria-label="插入标记"')
        ? insertTagButton
        : null,
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
      dispatchMouseSequence: () => undefined,
      readTextBySelectors: () => textContainer.textContent,
      isElementVisible: () => true,
      setEditableValue: () => undefined,
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchBlur: () => undefined,
      dispatchTabNavigation: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-color',
        sourceRaw: '布拉德米勒1<color=#fa7000>背打转身后2</color>，利用转身惯性快速勾手3<color=#fa7000>投篮4</color>。',
        sourceNormalized: '布拉德米勒1<color=#fa7000>背打转身后2</color>，利用转身惯性快速勾手3<color=#fa7000>投篮4</color>。',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [
          '<color=#fa7000>',
          '</color>',
          '<color=#fa7000>',
          '</color>'
        ],
        targetElement: target as never,
        platform: 'phrase',
        phraseUsesTagMarkup: true
      },
      'ブラッド・ミラーが<color=#fa7000>ポストターン後</color>、ターンの勢いを利用して素早くフック<color=#fa7000>シュート</color>を決める。'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_INPUT_SEQUENCE',
        payload: {
          x: 330,
          y: 110,
          operations: [
            {
              type: 'text',
              text: 'ブラッド・ミラーが'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'ポストターン後'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: '、ターンの勢いを利用して素早くフック'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'シュート'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'を決める。'
            }
          ]
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

test('PhraseAdapter.fillSegment confirms repeated identical placeholders with distinct Phrase chip numbers', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousHTMLInputElement = globalThis.HTMLInputElement;
  const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
  const messages: unknown[] = [];

  const target = new FakeElement('flex-row twe_target twe_textarea_wrapper', {
    top: 100,
    left: 260,
    width: 140,
    height: 20
  });
  const textContainer = new FakeElement('te_text_container');
  target.children = [textContainer];
  const insertTagButton = new FakeElement('twe-toolbar-button', {
    top: 30,
    left: 20,
    width: 20,
    height: 20
  });

  const restoreChrome = installChromeRecorder(messages, (message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'DEBUGGER_INPUT_SEQUENCE'
    ) {
      textContainer.textContent =
        'オフボール移動速度+1{1}m/s、ドリブル移動速度+2{1}m/s';
    }
  });

  globalThis.HTMLElement = FakeElement as never;
  globalThis.HTMLInputElement = FakeInputElement as never;
  globalThis.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {} as never;
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.includes('aria-label="插入标记"')
        ? insertTagButton
        : null,
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
      dispatchMouseSequence: () => undefined,
      readTextBySelectors: () => textContainer.textContent,
      isElementVisible: () => true,
      setEditableValue: () => undefined,
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchBlur: () => undefined,
      dispatchTabNavigation: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: 'segment-position-365',
        sourceRaw: '无球移动速度+1{1}米每秒，运球移动速度+2{1}米每秒',
        sourceNormalized: '无球移动速度+1{1}米每秒，运球移动速度+2{1}米每秒',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['{1}', '{1}'],
        targetElement: target as never,
        platform: 'phrase',
        phraseUsesTagMarkup: true
      },
      'オフボール移動速度+{1}m/s、ドリブル移動速度+{1}m/s'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(messages, [
      {
        type: 'DEBUGGER_INPUT_SEQUENCE',
        payload: {
          x: 330,
          y: 110,
          operations: [
            {
              type: 'text',
              text: 'オフボール移動速度+'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'm/s、ドリブル移動速度+'
            },
            {
              type: 'click',
              x: 30,
              y: 40
            },
            {
              type: 'text',
              text: 'm/s'
            }
          ]
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
