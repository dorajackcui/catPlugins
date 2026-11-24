import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GientTransEditorWriter,
  type GientTransEditorWriterHelpers
} from '../platforms/gientrans/editor-writer.ts';
import { installGientTransPasteEvents } from './gientrans-test-dom.ts';

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
    const diagnostic = createWriter().write(target as unknown as HTMLElement, 'Bonjour', 'Bonjour').fallbackNativeWrite;

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

test('GientTransEditorWriter does not collapse a missing line break during confirmation', () => {
  const target = new TestEditor(
    { contenteditable: 'true' },
    'Lance Dracopousse'
  );
  const restore = installDomGlobals({
    execCommand(_command, _showDefaultUi, value) {
      target.innerHTML = (value ?? '').replace('\n', ' ');
      return true;
    }
  });

  try {
    const text = 'Lance\nDracopousse';
    const diagnostic = createWriter().write(target as unknown as HTMLElement, text, text).fallbackNativeWrite;

    assert.equal(diagnostic.ok, false);
  } finally {
    restore();
  }
});

test('GientTransEditorWriter sends plain text and editor HTML through beforeinput', () => {
  const restorePaste = installGientTransPasteEvents();
  const target = new TestEditor({ contenteditable: 'true' }, 'Old target');
  const restore = installDomGlobals();
  const received: Array<{ plainText: string; editorHtml: string }> = [];
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
    const diagnostic = createWriter().write(target as unknown as HTMLElement, 'Bonjour', 'Bonjour').nativeWrite;

    assert.deepEqual(received, [
      { plainText: 'Bonjour', editorHtml: 'Bonjour' }
    ]);
    assert.equal(diagnostic.method, 'beforeinput-paste');
    assert.equal(diagnostic.ok, true);
    assert.equal(diagnostic.dispatchResult, false);
    assert.equal(diagnostic.defaultPrevented, true);
  } finally {
    restorePaste();
    restore();
  }
});

test('a paste that leaves a tag as plain text retries with HTML and verifies the native chip', () => {
  const text = '[Key]';
  const identity = '❮ph equiv-text="[Key]" id="4"/❯';
  const html = '<input type="tag" value="4">';
  const chips: Array<{ getAttribute(name: string): string | null }> = [];
  const target = Object.assign(new TestEditor({ contenteditable: 'true' }, ''), {
    querySelectorAll: () => chips
  });
  const attempts: string[] = [];
  const restorePaste = installGientTransPasteEvents();
  const restore = installDomGlobals({
    execCommand(command, _showUi, content) {
      attempts.push(command);
      assert.equal(content, html);
      chips.push({ getAttribute: name => name === 'tfull' ? identity : null });
      return true;
    }
  });
  target.dispatchHandler = event => {
    attempts.push(event.type);
    target.innerHTML = text;
    return true;
  };

  try {
    const result = createWriter().write(target as unknown as HTMLElement, text, html, [identity]);
    assert.deepEqual(attempts, ['beforeinput', 'insertHTML']);
    assert.equal(result.nativeWrite.ok, false);
    assert.equal(result.nativeHtmlWrite?.ok, true);
    assert.equal(result.usedFallbackInnerHtml, false);
  } finally {
    restorePaste();
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

test('GientTrans verifies the native IDs even when pasted text looks like the expected markup', async () => {
  const expected = '<input key="HardLock"></>を押す。';
  const canonical = '❮input key="HardLock"❯❮/❯を押す。';
  const ids = ['❮ph equiv-text="❰input key=&quot;HardLock&quot;❱" id="2"/❯', '❮ph equiv-text="❰/❱" id="3"/❯'];
  const writer = createWriter();
  const check = (textContent: string, tokens: string[]) => writer.waitForTextMatch({
    textContent,
    querySelectorAll: () => tokens.map(token => ({
      getAttribute: (name: string) => name === 'tfull' ? token : null
    }))
  } as unknown as HTMLElement, expected, ids);
  assert.equal(await check(expected, []), false);
  assert.equal(await check(canonical, [ids[0], ids[1].replace('id="3"', 'id="9"')]), false);
  assert.equal(await check(canonical, ids), true);
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
