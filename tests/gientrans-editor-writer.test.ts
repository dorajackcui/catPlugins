import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GientTransEditorWriter,
  type GientTransEditorWriterHelpers
} from '../platforms/gientrans/editor-writer.ts';

class TestEditor {
  private html: string;
  readonly events: string[] = [];
  dispatchHandler?: (event: Event) => boolean;

  constructor(
    private readonly attributes: Record<string, string>,
    public textContent: string,
    private readonly cell: HTMLElement | null = null
  ) {
    this.html = textContent;
  }

  get innerText(): string {
    return this.textContent;
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.textContent = value;
  }

  get isContentEditable(): boolean {
    return this.attributes.contenteditable === 'true';
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest<T extends Element = Element>(): T | null {
    return this.cell as T | null;
  }

  focus(): void {
    this.events.push('focus');
  }

  dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return this.dispatchHandler?.(event) ?? true;
  }
}

class FakeDataTransfer {
  private readonly values = new Map<string, string>();

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }

  getData(type: string): string {
    return this.values.get(type) ?? '';
  }
}

class FakeInputEvent extends Event {
  readonly data: string | null;
  readonly inputType: string;

  constructor(type: string, init?: InputEventInit) {
    super(type, init);
    this.data = init?.data ?? null;
    this.inputType = init?.inputType ?? '';
  }
}

function installDomGlobals(documentValue: Partial<Document> = {}): () => void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  globalThis.document = documentValue as Document;
  globalThis.window = {} as Window & typeof globalThis;

  return () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
}

function createWriter(
  calls: Array<{ target: HTMLElement; events: string[] }> = [],
  wait: (delayMs: number) => Promise<void> = async () => undefined
): GientTransEditorWriter {
  const helpers: GientTransEditorWriterHelpers = {
    dispatchMouseSequence(target, events) {
      calls.push({ target, events });
    }
  };

  return new GientTransEditorWriter(helpers, wait);
}

test('GientTransEditorWriter checks writability and activates the target cell', () => {
  const cell = {} as HTMLElement;
  const target = new TestEditor({ contenteditable: 'true' }, '', cell);
  const readOnlyTarget = new TestEditor({ contenteditable: 'false' }, '');
  const activationCalls: Array<{ target: HTMLElement; events: string[] }> = [];
  const writer = createWriter(activationCalls);

  assert.equal(writer.isWritable(target as unknown as HTMLElement), true);
  assert.equal(writer.isWritable(readOnlyTarget as unknown as HTMLElement), false);

  writer.activate(target as unknown as HTMLElement);

  assert.deepEqual(activationCalls, [
    {
      target: cell,
      events: ['mousedown', 'mouseup', 'click', 'dblclick']
    }
  ]);
  assert.deepEqual(target.events, ['focus']);
});

test('GientTransEditorWriter writes text through execCommand with diagnostics', () => {
  const target = new TestEditor({ contenteditable: 'true' }, 'Old target');
  const commands: Array<{ command: string; value: string | undefined }> = [];
  const restore = installDomGlobals({
    execCommand(command, _showDefaultUi, value) {
      commands.push({ command, value });
      target.innerHTML = value ?? '';
      return true;
    }
  });

  try {
    const diagnostic = createWriter().writeText(
      target as unknown as HTMLElement,
      'Bonjour'
    );

    assert.deepEqual(commands, [
      { command: 'insertText', value: 'Bonjour' }
    ]);
    assert.equal(diagnostic.method, 'insertText');
    assert.equal(diagnostic.attempted, true);
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.execResult, true);
    assert.equal(diagnostic.selected, false);
    assert.equal(diagnostic.before?.normalized, 'Old target');
    assert.equal(diagnostic.after?.normalized, 'Bonjour');
  } finally {
    restore();
  }
});

test('GientTransEditorWriter sends plain text and editor HTML through beforeinput', () => {
  const previousInputEvent = globalThis.InputEvent;
  const previousDataTransfer = globalThis.DataTransfer;
  const target = new TestEditor({ contenteditable: 'true' }, 'Old target');
  const restore = installDomGlobals();
  const received: Array<{ plainText: string; editorHtml: string }> = [];
  globalThis.InputEvent = FakeInputEvent as never;
  globalThis.DataTransfer = FakeDataTransfer as never;
  target.dispatchHandler = (event) => {
    const inputEvent = event as InputEvent & { dataTransfer?: DataTransfer };
    const plainText = inputEvent.dataTransfer?.getData('text/plain') ?? '';
    const editorHtml = inputEvent.dataTransfer?.getData('text/segment') ?? '';
    received.push({ plainText, editorHtml });
    target.innerHTML = editorHtml;
    event.preventDefault();
    return false;
  };

  try {
    const diagnostic = createWriter().writeBeforeInputPaste(
      target as unknown as HTMLElement,
      'Bonjour',
      'Bonjour'
    );

    assert.deepEqual(received, [
      { plainText: 'Bonjour', editorHtml: 'Bonjour' }
    ]);
    assert.equal(diagnostic.method, 'beforeinput-paste');
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.dispatchResult, false);
    assert.equal(diagnostic.defaultPrevented, true);
  } finally {
    globalThis.InputEvent = previousInputEvent;
    globalThis.DataTransfer = previousDataTransfer;
    restore();
  }
});

test('GientTransEditorWriter confirms NBSP text after retrying', async () => {
  const target = new TestEditor({ contenteditable: 'true' }, 'A B');
  const waits: number[] = [];
  const restore = installDomGlobals();
  const writer = createWriter([], async (delayMs) => {
    waits.push(delayMs);
    target.innerHTML = 'A\u00A0B';
  });

  try {
    assert.equal(
      await writer.waitForTextMatch(target as unknown as HTMLElement, 'A\u00A0B'),
      true
    );
    assert.deepEqual(waits, [80]);
  } finally {
    restore();
  }
});

test('GientTransEditorWriter makes five waits before confirmation times out', async () => {
  const target = new TestEditor({ contenteditable: 'true' }, 'Old target');
  const waits: number[] = [];
  const restore = installDomGlobals();
  const writer = createWriter([], async (delayMs) => {
    waits.push(delayMs);
  });

  try {
    assert.equal(
      await writer.waitForTextMatch(target as unknown as HTMLElement, 'Expected'),
      false
    );
    assert.deepEqual(waits, [80, 80, 80, 80, 80]);
  } finally {
    restore();
  }
});
