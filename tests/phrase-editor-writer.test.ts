import assert from 'node:assert/strict';
import test from 'node:test';

import type { BackgroundRequest } from '../types.ts';
import {
  PhraseEditorWriter,
  type PhraseEditorWriterHelpers,
  type PhraseEditorWriterServices
} from '../platforms/phrase/editor-writer.ts';

function makeRect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}

class TestElement {
  focusCalls = 0;
  scrollCalls = 0;

  constructor(
    private readonly rect: DOMRect,
    private readonly activationTarget: TestElement | null = null
  ) {}

  querySelector<T extends Element = Element>(): T | null {
    return this.activationTarget as unknown as T | null;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  scrollIntoView(): void {
    this.scrollCalls += 1;
  }

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}

function createHarness(options: {
  response?: { ok: true; data: null } | { ok: false; error: string };
  isVisible?: boolean;
  onWait?: (delayMs: number) => void;
} = {}) {
  const mouseSequences: Array<{ target: HTMLElement; eventNames: string[] }> = [];
  const messages: BackgroundRequest[] = [];
  const waits: number[] = [];
  const helpers: PhraseEditorWriterHelpers = {
    dispatchMouseSequence(target, eventNames) {
      mouseSequences.push({ target, eventNames });
    },
    isElementVisible: () => options.isVisible ?? true
  };
  const services: PhraseEditorWriterServices = {
    sendMessage: async (request) => {
      messages.push(request);
      return options.response ?? { ok: true, data: null };
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
      options.onWait?.(delayMs);
    }
  };

  return {
    writer: new PhraseEditorWriter(helpers, services),
    mouseSequences,
    messages,
    waits
  };
}

function installDocumentQuery(result: HTMLElement | null): () => void {
  const previousDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => result
  } as unknown as Document;

  return () => {
    globalThis.document = previousDocument;
  };
}

test('PhraseEditorWriter activates the nested target surface and waits for layout', async () => {
  const clickTarget = new TestElement(makeRect(10, 20, 100, 40));
  const target = new TestElement(makeRect(10, 20, 100, 40), clickTarget);
  const harness = createHarness();

  await harness.writer.activate(target as unknown as HTMLElement);

  assert.deepEqual(harness.mouseSequences, [
    {
      target: clickTarget as unknown as HTMLElement,
      eventNames: ['mousedown', 'mouseup', 'click', 'dblclick']
    }
  ]);
  assert.equal(clickTarget.focusCalls, 1);
  assert.deepEqual(harness.waits, [80]);
});

test('PhraseEditorWriter sends plain text at the target center', async () => {
  const target = new TestElement(makeRect(10, 20, 100, 40));
  const harness = createHarness();

  await harness.writer.write(target as unknown as HTMLElement, 'Bonjour', false);

  assert.equal(target.scrollCalls, 1);
  assert.deepEqual(harness.waits, [20]);
  assert.deepEqual(harness.messages, [
    {
      type: 'DEBUGGER_WRITE_TEXT',
      payload: {
        x: 60,
        y: 40,
        text: 'Bonjour'
      }
    }
  ]);
});

test('PhraseEditorWriter converts Phrase markup into tag-button click operations', async () => {
  const target = new TestElement(makeRect(10, 20, 100, 40));
  const insertTagButton = new TestElement(makeRect(200, 100, 40, 20));
  const restoreDocument = installDocumentQuery(
    insertTagButton as unknown as HTMLElement
  );
  const harness = createHarness();

  try {
    await harness.writer.write(
      target as unknown as HTMLElement,
      'Before {1} after',
      true
    );
  } finally {
    restoreDocument();
  }

  assert.equal(target.scrollCalls, 1);
  assert.equal(insertTagButton.scrollCalls, 1);
  assert.deepEqual(harness.waits, []);
  assert.deepEqual(harness.messages, [
    {
      type: 'DEBUGGER_INPUT_SEQUENCE',
      payload: {
        x: 60,
        y: 40,
        operations: [
          { type: 'text', text: 'Before ' },
          { type: 'click', x: 220, y: 110 },
          { type: 'text', text: ' after' }
        ]
      }
    }
  ]);
});

test('PhraseEditorWriter surfaces background trusted-input errors', async () => {
  const target = new TestElement(makeRect(10, 20, 100, 40));
  const harness = createHarness({
    response: { ok: false, error: 'Debugger denied.' }
  });
  let writeError: unknown;

  try {
    await harness.writer.write(target as unknown as HTMLElement, 'Bonjour', false);
  } catch (error) {
    writeError = error;
  }

  assert.equal(
    writeError instanceof Error ? writeError.message : null,
    'Debugger denied.'
  );
});

test('PhraseEditorWriter confirms normalized tag clips after retrying', async () => {
  let currentValue = 'Wrong';
  const harness = createHarness({
    onWait: () => {
      currentValue = '9 {1}';
    }
  });

  assert.equal(
    await harness.writer.waitForTextMatch(() => currentValue, '{1}'),
    true
  );
  assert.deepEqual(harness.waits, [120]);
});

test('PhraseEditorWriter makes seven waits before confirmation times out', async () => {
  const harness = createHarness();

  assert.equal(
    await harness.writer.waitForTextMatch(() => 'Wrong', 'Expected'),
    false
  );
  assert.deepEqual(harness.waits, [120, 120, 120, 120, 120, 120, 120]);
});
