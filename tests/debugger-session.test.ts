import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DebuggerSession,
  type ChromeDebuggerInputApi
} from '../background/debugger-session.ts';

function createHarness() {
  let lastError: { message: string } | null = null;
  let failNextAttach = false;
  let failNextCommand = false;
  const attachCalls: number[] = [];
  const scheduledDelays: number[] = [];
  const sleepDelays: number[] = [];
  const api: ChromeDebuggerInputApi = {
    runtime: {
      get lastError() {
        return lastError;
      }
    },
    debugger: {
      onDetach: {
        addListener() {}
      },
      attach({ tabId }, _version, callback) {
        attachCalls.push(tabId);
        if (failNextAttach) {
          failNextAttach = false;
          lastError = { message: 'Attach rejected.' };
        }
        callback();
        lastError = null;
      },
      detach(_target, callback) {
        callback();
      },
      sendCommand(_target, _method, _params, callback) {
        if (failNextCommand) {
          failNextCommand = false;
          lastError = { message: 'Command rejected.' };
        }
        callback();
        lastError = null;
      }
    }
  };
  const session = new DebuggerSession(api, {
    scheduleTimeout(_callback, delayMs) {
      scheduledDelays.push(delayMs);
      return scheduledDelays.length;
    },
    cancelTimeout() {},
    async sleep(delayMs) {
      sleepDelays.push(delayMs);
    }
  });

  return {
    session,
    attachCalls,
    scheduledDelays,
    sleepDelays,
    failAttach() {
      failNextAttach = true;
    },
    failCommand() {
      failNextCommand = true;
    }
  };
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('DebuggerSession can retry after an attach failure', async () => {
  const harness = createHarness();
  harness.failAttach();

  const error = await captureError(() => harness.session.prepare(7));
  await harness.session.prepare(7);

  assert.equal(
    error instanceof Error ? error.message : null,
    'Attach rejected.'
  );
  assert.deepEqual(harness.attachCalls, [7, 7]);
  assert.deepEqual(harness.scheduledDelays, [30000]);
  assert.deepEqual(harness.sleepDelays, [600]);
});

test('DebuggerSession surfaces protocol command failures', async () => {
  const harness = createHarness();
  harness.failCommand();

  const error = await captureError(() =>
    harness.session.sendCommand(
      { tabId: 9 },
      'Input.insertText',
      { text: 'Bonjour' }
    )
  );

  assert.equal(
    error instanceof Error ? error.message : null,
    'Command rejected.'
  );
});
