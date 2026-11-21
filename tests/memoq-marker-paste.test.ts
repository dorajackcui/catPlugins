import assert from 'node:assert/strict';
import test from 'node:test';
import { writeWebTransTarget } from '../platforms/memoq/webtrans-input.ts';
import { matchesMemoqNativeTarget } from '../platforms/memoq/text.ts';
import type { BackgroundRequest } from '../shared/message-types.ts';
import { fakeElement, fakeText } from './memoq-test-dom.ts';

const expected = 'A<1><2>B<2>';
const tag = (id: string) => fakeElement({
  className: 'tag inline-empty',
  children: [fakeElement({ className: 'tag-content', attributes: { 'data-tagid': id }, textContent: id })]
});
const nativeContent = () => fakeElement({ children: [fakeText('A'), tag('1'), tag('2'), fakeText('B'), tag('2')] });

test('webTrans verifies the position, kind and identity of actual native tags', () => {
  const verify = (root: ReturnType<typeof fakeElement>) => matchesMemoqNativeTarget(root as unknown as HTMLElement, expected);
  assert.equal(verify(nativeContent()), true);
  assert.equal(verify(fakeElement({ textContent: expected })), false);
  assert.equal(verify(fakeElement({ children: [fakeText('A<1>'), tag('2'), fakeText('B'), tag('2')] })), false);
  assert.equal(verify(fakeElement({ children: [fakeText('A'), tag('1'), fakeText('B'), tag('2'), tag('2')] })), false);
});

async function runInput(mode: 'native' | 'literal' | 'lost-focus' | 'second-click' | 'changed-row' |
  'no-event' | 'cleared-input' | 'buffered-input') {
  const oldChrome = (globalThis as { chrome?: unknown }).chrome;
  const messages: string[] = [];
  let content = fakeElement({});
  let focused = mode !== 'lost-focus' && mode !== 'second-click';
  const input = { id: 'editorHiddenInput', value: '' };
  const doc = Object.assign(new EventTarget(), { activeElement: input });
  const target = fakeElement({}) as unknown as HTMLElement;
  Object.defineProperties(target, {
    ownerDocument: { value: doc }, closest: { value: () => focused ? target : null }
  });
  try {
    Object.assign(globalThis, { chrome: { runtime: {
      sendMessage(request: BackgroundRequest, reply: (r: unknown) => void) {
        messages.push(request.type);
        if (request.type === 'DEBUGGER_INPUT_SEQUENCE') {
          assert.deepEqual(request.payload.operations, [{ type: 'wait', milliseconds: 150 }]);
          if (mode === 'second-click' && messages.length === 2) focused = true;
        }
        if (request.type === 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT') {
          assert.equal(request.payload.text, expected);
          if (mode === 'no-event') {
            reply({ ok: true, data: null });
            return;
          }
          if (mode === 'changed-row') focused = false;
          const event = new Event('beforeinput', { cancelable: true });
          Object.defineProperties(event, { target: { get: () => input }, data: { value: expected } });
          if (doc.dispatchEvent(event)) {
            if (mode === 'cleared-input' || mode === 'buffered-input') {
              input.value = expected;
              const edit = new Event('input');
              Object.defineProperty(edit, 'target', { get: () => input });
              doc.dispatchEvent(edit);
              if (mode === 'cleared-input') input.value = '';
            } else {
              content = mode === 'literal' ? fakeElement({ textContent: expected }) : nativeContent();
            }
          }
        }
        reply({ ok: true, data: null });
      }
    } } });
    const getContentRoot = () => content as unknown as HTMLElement;
    await writeWebTransTarget({ target, resolveTarget: () => target, sourceMatches: () => true,
      getContentRoot, matchesTarget: (_cell, value) => matchesMemoqNativeTarget(getContentRoot(), value), expected });
    return { messages, error: '' };
  } catch (error) {
    return { messages, error: error instanceof Error ? error.message : String(error) };
  } finally {
    Object.assign(globalThis, { chrome: oldChrome });
  }
}

test('webTrans focuses the target then submits every tag in one trusted text input', async () => {
  assert.deepEqual(await runInput('native'), {
    messages: ['DEBUGGER_INPUT_SEQUENCE', 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT'], error: ''
  });
});

test('webTrans stops before entering text if the target loses focus', async () => {
  const absent = await runInput('lost-focus');
  assert.deepEqual(absent.messages, ['DEBUGGER_INPUT_SEQUENCE', 'DEBUGGER_INPUT_SEQUENCE']);
  assert.equal(absent.error.includes('focus'), true);
  const changed = await runInput('changed-row');
  assert.equal(changed.error.includes('at the moment of input'), true);
});

test('webTrans recovers a missed focus click and submits the complete target exactly once', async () => {
  assert.deepEqual(await runInput('second-click'), {
    messages: ['DEBUGGER_INPUT_SEQUENCE', 'DEBUGGER_INPUT_SEQUENCE', 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT'],
    error: ''
  });
});

test('webTrans stops on literal or partial tags without sending a second input', async () => {
  const result = await runInput('literal');
  assert.deepEqual(result.messages, ['DEBUGGER_INPUT_SEQUENCE', 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT']);
  assert.equal(result.error.includes('native tag positions'), true);
});

test('webTrans distinguishes missing input, discarded input and a pending buffer without retyping', async () => {
  for (const [mode, message] of [
    ['no-event', 'did not receive an input event'],
    ['cleared-input', 'cleared its input without rendering'],
    ['buffered-input', 'still in the editor input buffer']
  ] as const) {
    const result = await runInput(mode);
    assert.equal(result.error.includes(message), true, result.error);
    assert.deepEqual(result.messages, ['DEBUGGER_INPUT_SEQUENCE', 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT']);
  }
});
