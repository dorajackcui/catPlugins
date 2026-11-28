import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { PhraseCellContent } from '../domain/phrase-marker-fill.ts';
import { PhraseEditorWriter } from '../platforms/phrase/editor-writer.ts';
import type { BackgroundRequest } from '../shared/message-types.ts';

function createHarness(t: TestContext) {
  const previousHTMLElement = globalThis.HTMLElement;
  const doc = Object.assign(new EventTarget(), { activeElement: null as Cell | null });
  class Cell {
    ownerDocument = doc;
    isConnected = true;

    constructor(
      private readonly rect: { left: number; top: number; width: number; height: number },
      private readonly input?: Cell
    ) {}

    contains(element: unknown): boolean { return element === this || element === this.input; }
    matches(selector: string): boolean { return selector === 'input.twe-main-input'; }
    getBoundingClientRect() { return this.rect; }
  }
  const input = new Cell({ left: 0, top: 0, width: 1, height: 1 });
  const target = new Cell({ left: 10, top: 20, width: 100, height: 40 }, input);
  const button = new Cell({ left: 200, top: 100, width: 40, height: 20 });
  Object.assign(doc, {
    querySelector: () => button,
    elementFromPoint: (x: number) => x < 100 ? target : button
  });
  globalThis.HTMLElement = Cell as never;
  t.after(() => { globalThis.HTMLElement = previousHTMLElement; });

  const waits: number[] = [];
  const messages: BackgroundRequest[] = [];
  const state = {
    cell: { text: '', markers: [] } as PhraseCellContent,
    onRequest: (_request: BackgroundRequest) => {},
    error: ''
  };
  const writer = new PhraseEditorWriter({
    sendMessage: async request => {
      messages.push(request);
      if (request.type === 'DEBUGGER_INPUT_SEQUENCE' && !request.payload.alreadyFocused) doc.activeElement = input;
      state.onRequest(request);
      return state.error ? { ok: false, error: state.error } : { ok: true, data: null };
    },
    wait: async ms => { waits.push(ms); }
  });
  const row = {
    resolve: () => target as unknown as HTMLElement,
    read: () => state.cell
  };
  return { doc, button, writer, row, state, waits, messages };
}

const FOCUS_REQUEST = {
  type: 'DEBUGGER_INPUT_SEQUENCE',
  payload: { x: 60, y: 40, operations: [{ type: 'wait', milliseconds: 30 }] }
};

test('PhraseEditorWriter sends literal placeholder text through the verified native input', async t => {
  const { writer, row, state, messages } = createHarness(t);
  const text = 'Bonjour {1}';
  state.onRequest = request => {
    if (request.type === 'DEBUGGER_INPUT_SEQUENCE' && request.payload.alreadyFocused) {
      state.cell = { text, markers: [] };
    }
  };

  assert.equal(await writer.write(row, text), true);
  assert.deepEqual(messages, [
    { type: 'DEBUGGER_PREPARE' }, FOCUS_REQUEST,
    { type: 'DEBUGGER_INPUT_SEQUENCE', payload: { alreadyFocused: true, operations: [{ type: 'text', text }] } }
  ]);
});

test('PhraseEditorWriter inserts a reordered marker by ID and preserves the remaining button order', async t => {
  const { writer, row, state, messages } = createHarness(t);
  const first = { id: 1, token: '{1}', label: '{0}', offset: 0 };
  const second = { id: 2, token: '{2}', label: '{1}', offset: 3 };
  const tenth = { id: 10, token: '{10}', label: '<color=red>', offset: 6 };
  const text = '{1}×{0}<color=red>';
  state.onRequest = () => {
    if (messages.length === 6) state.cell = {
      text, markers: [{ ...second, offset: 0 }, { ...first, offset: 4 }, { ...tenth, offset: 7 }]
    };
  };

  const filled = await writer.write(row, text, {
    sourceMarkers: [first, second, tenth],
    parts: [
      { type: 'tag', marker: second }, { type: 'text', value: '×' },
      { type: 'tag', marker: first }, { type: 'tag', marker: tenth }
    ]
  });

  assert.equal(filled, true);
  assert.deepEqual(messages, [
    { type: 'DEBUGGER_PREPARE' }, FOCUS_REQUEST,
    ...[
      { type: 'phraseTag', id: 2 }, { type: 'text', text: '×' },
      { type: 'click', x: 220, y: 110 }, { type: 'click', x: 220, y: 110 }
    ].map(operation => ({ type: 'DEBUGGER_INPUT_SEQUENCE', payload: { alreadyFocused: true, operations: [operation] } }))
  ]);
});

test('PhraseEditorWriter rejects literal text in place of a native marker', async t => {
  const { writer, row, state, waits } = createHarness(t);
  const marker = { id: 1, token: '{1}', label: '{name}', offset: 0 };
  state.onRequest = request => {
    if (request.type === 'DEBUGGER_INPUT_SEQUENCE' && request.payload.alreadyFocused) {
      state.cell = { text: marker.label, markers: [] };
    }
  };

  assert.equal(await writer.write(row, marker.label, {
    sourceMarkers: [marker], parts: [{ type: 'tag', marker }]
  }), false);
  assert.deepEqual(waits.filter(ms => ms === 120), Array(7).fill(120));
});

test('PhraseEditorWriter blocks text if input moves to another row after the trusted click', async t => {
  const { doc, button, writer, row, state } = createHarness(t);
  let canceled = false;
  state.onRequest = request => {
    if (request.type !== 'DEBUGGER_INPUT_SEQUENCE' || !request.payload.alreadyFocused) return;
    doc.activeElement = button;
    const event = new Event('beforeinput', { cancelable: true });
    Object.defineProperty(event, 'target', { value: button });
    doc.dispatchEvent(event);
    canceled = event.defaultPrevented;
  };

  await assert.rejects(writer.write(row, 'Target text'), /active Phrase target changed/);
  assert.equal(canceled, true);
});

test('PhraseEditorWriter refuses a target populated during debugger preparation', async t => {
  const { writer, row, state, messages } = createHarness(t);
  state.onRequest = () => { state.cell = { text: 'Existing translation', markers: [] }; };

  await assert.rejects(writer.write(row, 'Target text'), /empty target changed before input/);
  assert.deepEqual(messages, [{ type: 'DEBUGGER_PREPARE' }]);
});

test('PhraseEditorWriter surfaces background trusted input errors', async t => {
  const { writer, row, state } = createHarness(t);
  state.error = 'Debugger denied.';

  await assert.rejects(writer.write(row, 'Bonjour'), /Debugger denied/);
});
