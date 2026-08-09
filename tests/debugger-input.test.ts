import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DebuggerInputController,
  type ChromeDebuggerInputApi
} from '../background/debugger-input.ts';

interface RecordedCommand {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

function createHarness() {
  const runtime: ChromeDebuggerInputApi['runtime'] = { lastError: null };
  const attachCalls: Array<{ tabId: number; protocolVersion: string }> = [];
  const detachCalls: number[] = [];
  const commands: RecordedCommand[] = [];
  const timers: Array<{
    handle: number;
    callback: () => void;
    delayMs: number;
    canceled: boolean;
  }> = [];
  let nextTimerHandle = 1;
  let detachListener: ((source: { tabId?: number }) => void) | undefined;

  const api: ChromeDebuggerInputApi = {
    runtime,
    debugger: {
      onDetach: {
        addListener(listener) {
          detachListener = listener;
        }
      },
      attach({ tabId }, protocolVersion, callback) {
        attachCalls.push({ tabId, protocolVersion });
        callback();
      },
      detach({ tabId }, callback) {
        detachCalls.push(tabId);
        callback();
      },
      sendCommand({ tabId }, method, params, callback) {
        commands.push({ tabId, method, params });
        callback();
      }
    }
  };

  const controller = new DebuggerInputController(api, {
    scheduleTimeout(callback, delayMs) {
      const handle = nextTimerHandle;
      nextTimerHandle += 1;
      timers.push({ handle, callback, delayMs, canceled: false });
      return handle;
    },
    cancelTimeout(handle) {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer) {
        timer.canceled = true;
      }
    },
    sleep: async () => undefined
  });

  return {
    controller,
    attachCalls,
    detachCalls,
    commands,
    timers,
    emitDetach(source: { tabId?: number }) {
      detachListener?.(source);
    },
    latestActiveTimer() {
      return [...timers].reverse().find((timer) => !timer.canceled);
    }
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('DebuggerInputController serializes concurrent preparation and attaches once', async () => {
  const harness = createHarness();

  await Promise.all([
    harness.controller.prepare(7),
    harness.controller.prepare(7)
  ]);

  assert.deepEqual(harness.attachCalls, [
    { tabId: 7, protocolVersion: '1.3' }
  ]);
  assert.equal(harness.timers.length, 2);
  assert.equal(harness.timers[0]?.canceled, true);
  assert.equal(harness.timers[1]?.delayMs, 30000);
});

test('DebuggerInputController writes text after a trusted press and release', async () => {
  const harness = createHarness();

  await harness.controller.writeText(11, 30, 40, 'Bonjour');

  assert.deepEqual(harness.commands, [
    {
      tabId: 11,
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x: 30,
        y: 40,
        button: 'left',
        clickCount: 1
      }
    },
    {
      tabId: 11,
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: 30,
        y: 40,
        button: 'left',
        clickCount: 1
      }
    },
    {
      tabId: 11,
      method: 'Input.insertText',
      params: { text: 'Bonjour' }
    }
  ]);
});

test('DebuggerInputController dispatches absolute memoQ navigation atomically', async () => {
  const harness = createHarness();

  await harness.controller.runSequence(13, 10, 20, [
    { type: 'documentHome' },
    { type: 'moveRight', count: 2 },
    { type: 'deleteForward' },
    { type: 'undo' },
    { type: 'key', key: 'F9' }
  ]);

  assert.deepEqual(
    harness.commands.map(({ method, params }) => ({
      method,
      type: params.type,
      key: params.key,
      modifiers: params.modifiers
    })),
    [
      {
        method: 'Input.dispatchMouseEvent',
        type: 'mousePressed',
        key: undefined,
        modifiers: undefined
      },
      {
        method: 'Input.dispatchMouseEvent',
        type: 'mouseReleased',
        key: undefined,
        modifiers: undefined
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'rawKeyDown',
        key: 'Control',
        modifiers: 2
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'rawKeyDown',
        key: 'Home',
        modifiers: 2
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'Home',
        modifiers: 2
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'Control',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'rawKeyDown',
        key: 'ArrowRight',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'ArrowRight',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'rawKeyDown',
        key: 'ArrowRight',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'ArrowRight',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'rawKeyDown',
        key: 'Delete',
        modifiers: 0
      },
      {
        method: 'Input.dispatchKeyEvent',
        type: 'keyUp',
        key: 'Delete',
        modifiers: 0
      },
      { method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', key: 'Control', modifiers: 2 },
      { method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', key: 'z', modifiers: 2 },
      { method: 'Input.dispatchKeyEvent', type: 'keyUp', key: 'z', modifiers: 2 },
      { method: 'Input.dispatchKeyEvent', type: 'keyUp', key: 'Control', modifiers: 0 },
      { method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', key: 'F9', modifiers: 0 },
      { method: 'Input.dispatchKeyEvent', type: 'keyUp', key: 'F9', modifiers: 0 }
    ]
  );
});

test('DebuggerInputController keeps active attachments alive and detaches when idle', async () => {
  const harness = createHarness();

  harness.controller.keepAlive(17);
  assert.equal(harness.timers.length, 0);

  await harness.controller.prepare(17);
  harness.controller.keepAlive(17);

  assert.equal(harness.timers.length, 2);
  assert.equal(harness.timers[0]?.canceled, true);

  harness.latestActiveTimer()?.callback();
  await flushPromises();

  assert.deepEqual(harness.detachCalls, [17]);

  await harness.controller.prepare(17);
  assert.equal(harness.attachCalls.length, 2);
});

test('DebuggerInputController forgets externally detached tabs and validates payloads', async () => {
  const harness = createHarness();

  await harness.controller.prepare(19);
  harness.emitDetach({ tabId: 19 });
  await harness.controller.prepare(19);

  assert.equal(harness.attachCalls.length, 2);
  assert.equal(harness.timers[0]?.canceled, true);

  let writeError: unknown;
  try {
    await harness.controller.writeText(19, Number.NaN, 20, 'text');
  } catch (error) {
    writeError = error;
  }

  let sequenceError: unknown;
  try {
    await harness.controller.runSequence(19, 10, 20, []);
  } catch (error) {
    sequenceError = error;
  }

  assert.equal(
    writeError instanceof Error ? writeError.message : null,
    'Invalid trusted write payload.'
  );
  assert.equal(
    sequenceError instanceof Error ? sequenceError.message : null,
    'Invalid trusted sequence payload.'
  );
});
