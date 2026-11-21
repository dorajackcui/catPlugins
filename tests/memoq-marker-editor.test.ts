import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/types.ts';
import type { BackgroundRequest } from '../shared/message-types.ts';
import type { MemoqDomProfile } from '../platforms/memoq/dom-profile-types.ts';
import { createMemoqMarkerEditor } from '../platforms/memoq/marker-editor.ts';
import { appendChild, fakeElement, fakeText, type FakeElement } from './memoq-test-dom.ts';

function makeCell(left: number) {
  const content = fakeElement({
    className: 'content-container',
    rect: { left, top: 10, width: 120, height: 24 },
    children: [
      fakeElement({ textContent: '${1}  \u00A0' }),
      fakeElement({ className: 'tag inline-empty', textContent: '7' })
    ]
  }) as unknown as HTMLElement;
  const writeTarget = fakeElement({
    className: 'write-target',
    rect: { left: left + 10, top: 30, width: 100, height: 20 }
  }) as unknown as HTMLElement;
  const cell = {} as HTMLElement;
  return { cell, content, writeTarget };
}

function createHarness(rowNumber: string | undefined = '869') {
  const stale = makeCell(100);
  const current = makeCell(300);
  let active: typeof current | null = stale;
  const profile: MemoqDomProfile = {
    id: 'legacy-webtrans',
    matches: () => true,
    findVisibleRows: () => [],
    findCells: () => null,
    readRowNumber: () => rowNumber,
    findScrollRoot: () => null,
    findCurrentTargetByRowNumber: () => active?.cell ?? null,
    getContentRoot: (cell) => cell === stale.cell ? stale.content : current.content,
    getWriteTarget: (cell) => cell === stale.cell ? stale.writeTarget : current.writeTarget,
    createSyntheticScrollTarget: () => null
  };
  const segment: RuntimeSegment = {
    domId: '869', rowNumber, sourceRaw: 'Source<7>Text', sourceNormalized: 'Source<7>Text',
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true,
    placeholderTokens: ['<7>'], targetElement: stale.cell, platform: 'memoq'
  };
  const editor = createMemoqMarkerEditor({
    profile, segment,
    resolveTargetByRowNumber: (requestedRow) => {
      assert.equal(requestedRow, '869');
      return active?.cell ?? null;
    }
  });
  const messages: BackgroundRequest[] = [];
  const previousWindow = globalThis.window;
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  globalThis.window = {
    setTimeout: (callback: () => void) => { callback(); return 0; }
  } as unknown as Window & typeof globalThis;
  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: BackgroundRequest, callback: (result: unknown) => void) => {
        messages.push(message);
        callback({ ok: true, data: null });
      }
    }
  };
  return {
    editor, stale, current, messages,
    replace: () => { active = current; },
    remove: () => { active = null; },
    restore: () => {
      globalThis.window = previousWindow;
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  };
}

test('memoQ marker editor re-resolves targets and escapes literal placeholders only on input', async () => {
  const harness = createHarness();
  try {
    assert.equal(harness.editor.resolveTarget(), harness.stale.writeTarget);
    assert.equal(harness.editor.readCurrentValue(), '${1}  \u00A0<7>');
    harness.replace();
    await harness.editor.writeText(harness.stale.writeTarget, '${1}  \u00A0\uE000');
    await harness.editor.runInput(harness.stale.writeTarget, { type: 'key', key: 'F9' });

    assert.deepEqual(harness.messages, [
      { type: 'MEMOQ_DEBUGGER_WRITE_TEXT', payload: { x: 360, y: 40, text: '${{1}  \u00A0\uE000' } },
      { type: 'DEBUGGER_INPUT_SEQUENCE', payload: { x: 301, y: 17, operations: [{ type: 'key', key: 'F9' }] } }
    ]);
  } finally {
    harness.restore();
  }
});

test('memoQ marker editor never writes to a stale numbered row after it disappears', async () => {
  const harness = createHarness();
  try {
    harness.remove();
    assert.equal(harness.editor.resolveTarget(), null);
    assert.equal(harness.editor.readCurrentValue(), null);
    let failures = 0;
    for (const action of [
      () => harness.editor.writeText(harness.stale.writeTarget, 'Text'),
      () => harness.editor.runInput(harness.stale.writeTarget, { type: 'key', key: 'F9' })
    ]) {
      try { await action(); } catch { failures += 1; }
    }
    assert.equal(failures, 2);
    assert.deepEqual(harness.messages, []);
  } finally {
    harness.restore();
  }
});

test('memoQ marker editor retains the segment target when a row number is unavailable', async () => {
  const harness = createHarness('');
  try {
    harness.remove();
    assert.equal(harness.editor.resolveTarget(), harness.stale.writeTarget);
    await harness.editor.writeText(harness.stale.writeTarget, 'Text');
    assert.deepEqual(harness.messages, [
      { type: 'MEMOQ_DEBUGGER_WRITE_TEXT', payload: { x: 160, y: 40, text: 'Text' } }
    ]);
  } finally {
    harness.restore();
  }
});

test('memoQ marker editor uses a verified caret on the re-resolved row or navigates from its start', async () => {
  const harness = createHarness();
  try {
    const { content } = harness.current;
    const suffix = '👩‍🚀A\uE000Z';
    const node = fakeText(suffix);
    appendChild(content as unknown as FakeElement, node);
    Object.defineProperty(node, 'length', { value: suffix.length });
    const offset = suffix.indexOf('\uE000');
    const rect = { left: 345, top: 14, height: 12 };
    const range = {
      setStart(candidate: Text, index: number) {
        assert.equal(candidate, node);
        assert.equal(index, offset);
      },
      collapse() {},
      getBoundingClientRect: () => rect
    };
    let hitOffset = offset;
    Object.defineProperty(content, 'contains', { value: (hit: Element) => hit === content });
    Object.defineProperty(content, 'ownerDocument', { value: {
      createRange: () => range,
      elementFromPoint: () => content,
      caretPositionFromPoint: () => ({ offsetNode: node, offset: hitOffset })
    } });

    // Virtualization replaces the cell during the scroll/settle before dispatch.
    globalThis.window.setTimeout = ((callback: () => void) => {
      harness.replace();
      callback();
      return 0;
    }) as typeof window.setTimeout;
    const prefix = '${1}  \u00A0<7>';
    const position = { expectedValue: prefix + suffix, textOffset: prefix.length + offset, cursorOffset: 10 };
    const action = { type: 'deleteForward' } as const;
    await harness.editor.runInput(harness.stale.writeTarget, action, position);
    assert.deepEqual(harness.messages[0], {
      type: 'DEBUGGER_INPUT_SEQUENCE',
      payload: { x: 346, y: 20, operations: [action] }
    });

    hitOffset = offset + 1;
    await harness.editor.runInput(harness.current.writeTarget, action, position);
    assert.deepEqual(harness.messages[1], {
      type: 'DEBUGGER_INPUT_SEQUENCE',
      payload: { x: 301, y: 17, operations: [{ type: 'moveLeft', count: 1 }, { type: 'moveRight', count: 10 }, action] }
    });
  } finally {
    harness.restore();
  }
});

test('memoQ marker editor declines to send keys if the re-resolved content changed', async () => {
  const harness = createHarness();
  try {
    let error: unknown;
    try {
      await harness.editor.runInput(harness.stale.writeTarget, { type: 'key', key: 'F9' }, {
        expectedValue: 'A different target', textOffset: 0, cursorOffset: 0
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error instanceof Error && error.message.includes('target changed'), true);
    assert.deepEqual(harness.messages, []);
  } finally {
    harness.restore();
  }
});
