import assert from 'node:assert/strict';
import test from 'node:test';

import { writeTrustedTextToElement } from '../trusted-text-writer.ts';

function installChromeRecorder(
  messages: unknown[],
  response: unknown = { ok: true, data: null }
): () => void {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (nextResponse: unknown) => void) => {
        messages.push(message);
        callback(response);
      }
    }
  };

  return () => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
  };
}

test('writeTrustedTextToElement sends memoQ debugger text write with center coordinates', async () => {
  const messages: unknown[] = [];
  const restoreChrome = installChromeRecorder(messages);
  const target = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 40
    })
  } as unknown as HTMLElement;

  try {
    await writeTrustedTextToElement(target, 'Bonjour', {
      requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT'
    });
  } finally {
    restoreChrome();
  }

  assert.deepEqual(messages, [
    {
      type: 'MEMOQ_DEBUGGER_WRITE_TEXT',
      payload: {
        x: 50,
        y: 40,
        text: 'Bonjour'
      }
    }
  ]);
});

test('writeTrustedTextToElement re-resolves the target after settling', async () => {
  const previousWindow = globalThis.window;
  const messages: unknown[] = [];
  const restoreChrome = installChromeRecorder(messages);
  const staleTarget = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 40
    })
  } as unknown as HTMLElement;
  const currentTarget = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 50,
      height: 20
    })
  } as unknown as HTMLElement;
  let resolveCount = 0;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    await writeTrustedTextToElement(staleTarget, 'Bonjour', {
      requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
      settleMs: 20,
      resolveElement: () => {
        resolveCount += 1;
        return resolveCount === 1 ? staleTarget : currentTarget;
      }
    });
  } finally {
    restoreChrome();
    globalThis.window = previousWindow;
  }

  assert.deepEqual(messages, [
    {
      type: 'MEMOQ_DEBUGGER_WRITE_TEXT',
      payload: {
        x: 125,
        y: 210,
        text: 'Bonjour'
      }
    }
  ]);
});

test('writeTrustedTextToElement refuses a missing required re-resolved target', async () => {
  const previousWindow = globalThis.window;
  const messages: unknown[] = [];
  const restoreChrome = installChromeRecorder(messages);
  const target = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 40
    })
  } as unknown as HTMLElement;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    let error: unknown;

    try {
      await writeTrustedTextToElement(target, 'Bonjour', {
        requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
        settleMs: 20,
        requireResolvedElement: true,
        resolveElement: () => null
      });
    } catch (nextError) {
      error = nextError;
    }

    assert.equal(error instanceof Error, true);
    assert.equal(
      error instanceof Error ? /could not be re-resolved/i.test(error.message) : false,
      true
    );
  } finally {
    restoreChrome();
    globalThis.window = previousWindow;
  }

  assert.deepEqual(messages, []);
});

test('writeTrustedTextToElement rejects zero-size targets', async () => {
  const target = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 0,
      height: 40
    })
  } as unknown as HTMLElement;

  let error: unknown;

  try {
    await writeTrustedTextToElement(target, 'Bonjour', {
      requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT'
    });
  } catch (nextError) {
    error = nextError;
  }

  assert.equal(error instanceof Error, true);
  assert.equal(
    /target element is not visible enough to write/.test((error as Error).message),
    true
  );
});

test('writeTrustedTextToElement surfaces background write errors', async () => {
  const messages: unknown[] = [];
  const restoreChrome = installChromeRecorder(messages, { ok: false, error: 'debugger failed' });
  const target = {
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 40
    })
  } as unknown as HTMLElement;

  try {
    let error: unknown;

    try {
      await writeTrustedTextToElement(target, 'Bonjour', {
        requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT'
      });
    } catch (nextError) {
      error = nextError;
    }

    assert.equal(error instanceof Error, true);
    assert.equal(/debugger failed/.test((error as Error).message), true);
  } finally {
    restoreChrome();
  }
});
