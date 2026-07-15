import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackgroundEditorSession,
  type BackgroundEditorSessionPort
} from '../background/editor-session.ts';

function createHarness(options: {
  tab?: { id: number; url?: string };
  frames?: Array<{ frameId: number; parentFrameId: number; url?: string }>;
  responses?: unknown[];
} = {}) {
  const events: string[] = [];
  const responses = [...(options.responses ?? [])];
  const scriptCalls: Array<{
    tabId: number;
    files: string[];
    options?: { allFrames?: boolean; frameIds?: number[] };
  }> = [];
  const messages: Array<{
    tabId: number;
    message: unknown;
    options?: { frameId?: number };
  }> = [];
  const logs: Array<{
    message: string;
    payload: Record<string, unknown>;
  }> = [];
  const port: BackgroundEditorSessionPort = {
    async queryActiveTab() {
      events.push('query-tab');
      return (
        options.tab ?? {
          id: 42,
          url: 'https://app.phrase.com/editor/project-1'
        }
      );
    },
    async executeScript(tabId, files, scriptOptions) {
      events.push('execute-script');
      scriptCalls.push({ tabId, files, options: scriptOptions });
    },
    async getAllFrames() {
      events.push('get-frames');
      return options.frames ?? [];
    },
    async sendTabMessage<TRequest, TResponse>(
      tabId: number,
      message: TRequest,
      messageOptions?: { frameId?: number }
    ): Promise<TResponse> {
      events.push(`send:${(message as { type?: string }).type ?? 'unknown'}`);
      messages.push({ tabId, message, options: messageOptions });
      return (
        responses.length > 0
          ? responses.shift()
          : { ok: true, data: null }
      ) as TResponse;
    },
    logInfo(message, payload) {
      logs.push({ message, payload });
    }
  };

  return {
    session: new BackgroundEditorSession(port),
    events,
    scriptCalls,
    messages,
    logs
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

test('BackgroundEditorSession prepares and targets the Phrase editor frame', async () => {
  const harness = createHarness({
    tab: {
      id: 42,
      url: 'https://cloud.memsource.com/web/job/job-1/translate'
    },
    frames: [
      {
        frameId: 7,
        parentFrameId: 0,
        url: 'https://editor.memsource.com/twe/translation/job/job-1'
      }
    ],
    responses: [{ ok: true, data: ['segment-1'] }]
  });

  const tab = await harness.session.prepare();
  const data = await harness.session.request<string[]>(tab, {
    type: 'CONTENT_SCAN',
    payload: { runId: 'run-1' }
  });

  assert.deepEqual(tab, {
    id: 42,
    url: 'https://cloud.memsource.com/web/job/job-1/translate',
    frameId: 7
  });
  assert.deepEqual(harness.scriptCalls, [
    {
      tabId: 42,
      files: ['content-script.js'],
      options: { allFrames: true }
    }
  ]);
  assert.deepEqual(harness.messages, [
    {
      tabId: 42,
      message: { type: 'CONTENT_SCAN', payload: { runId: 'run-1' } },
      options: { frameId: 7 }
    }
  ]);
  assert.deepEqual(data, ['segment-1']);
  assert.equal(harness.logs[0]?.payload.platform, 'phrase');
});

test('BackgroundEditorSession rejects unsupported tabs before injection', async () => {
  const harness = createHarness({
    tab: { id: 9, url: 'https://example.com/' }
  });

  const error = await captureError(() => harness.session.prepare());

  assert.equal(
    error instanceof Error ? error.message : null,
    'Open a Phrase, memoQ, or GientTrans editor tab before running Preview, Fill, or Export.'
  );
  assert.deepEqual(harness.events, ['query-tab']);
  assert.equal(harness.logs[0]?.message, 'Rejected active tab for CAT run.');
});

test('BackgroundEditorSession surfaces content-script response errors', async () => {
  const harness = createHarness({
    responses: [{ ok: false, error: 'Editor scan failed.' }]
  });

  const error = await captureError(() =>
    harness.session.request(
      { id: 42, url: 'https://app.phrase.com/editor/project-1' },
      { type: 'CONTENT_SCAN', payload: { runId: 'run-error' } }
    )
  );

  assert.equal(
    error instanceof Error ? error.message : null,
    'Editor scan failed.'
  );
});

test('BackgroundEditorSession stops the stored frame without reinjection', async () => {
  const harness = createHarness();

  await harness.session.stop({
    tabId: 91,
    frameId: 0
  });

  assert.deepEqual(harness.events, ['send:CONTENT_STOP']);
  assert.deepEqual(harness.messages, [
    {
      tabId: 91,
      message: { type: 'CONTENT_STOP' },
      options: { frameId: 0 }
    }
  ]);
});

test('BackgroundEditorSession prepares a fallback target when run state lacks a tab', async () => {
  const harness = createHarness({
    frames: [
      {
        frameId: 8,
        parentFrameId: 0,
        url: 'https://editor.memsource.com/twe/translation/job/job-2'
      }
    ]
  });

  await harness.session.stop({});

  assert.deepEqual(harness.events, [
    'query-tab',
    'execute-script',
    'get-frames',
    'send:CONTENT_STOP'
  ]);
  assert.deepEqual(harness.messages[0], {
    tabId: 42,
    message: { type: 'CONTENT_STOP' },
    options: { frameId: 8 }
  });
});
