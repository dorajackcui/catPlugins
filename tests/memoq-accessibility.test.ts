import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseMemoqAccessibilityTextBoxes,
  MemoqAdapter,
  shouldUseMemoqAccessibilityTextBox
} from '../memoq-adapter.ts';

function installTrustedClickRecorder(
  messages: unknown[] = [],
  onMessage?: (message: unknown) => void
): () => void {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        messages.push(message);
        onMessage?.(message);
        callback({ ok: true, data: null });
      }
    }
  };

  return () => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
  };
}

test('shouldUseMemoqAccessibilityTextBox accepts disabled source textboxes for reading', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: '',
        disabled: true,
        readOnly: false,
        value: 'X-Server<1>PWR Rank',
        textContent: ''
      },
      { requireWritable: false }
    ),
    true
  );
});

test('shouldUseMemoqAccessibilityTextBox rejects disabled target textboxes for writing', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: '',
        disabled: true,
        readOnly: false,
        value: 'X-Server<1>PWR Rank',
        textContent: ''
      },
      { requireWritable: true }
    ),
    false
  );
});

test('shouldUseMemoqAccessibilityTextBox ignores memoQ hidden input', () => {
  assert.equal(
    shouldUseMemoqAccessibilityTextBox(
      {
        id: 'editorHiddenInput',
        disabled: false,
        readOnly: false,
        value: '',
        textContent: ''
      },
      { requireWritable: false }
    ),
    false
  );
});

test('chooseMemoqAccessibilityTextBoxes pairs a disabled source with a writable target', () => {
  const pair = chooseMemoqAccessibilityTextBoxes([
    {
      id: '',
      disabled: true,
      readOnly: false,
      value: 'X-Server<1>PWR Rank',
      textContent: ''
    },
    {
      id: '',
      disabled: false,
      readOnly: false,
      value: '',
      textContent: ''
    }
  ]);

  assert.equal(pair?.source.value, 'X-Server<1>PWR Rank');
  assert.equal(pair?.target.disabled, false);
});

const NBSP = String.fromCharCode(0x00a0);

test('MemoqAdapter.fillSegment confirms when the rendered cell shows plain spaces for nbsp', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const restoreChrome = installTrustedClickRecorder();
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const value = `Bonjour${NBSP}le monde${NBSP}!`;
  const swallowedValue = value.replace(new RegExp(NBSP, 'g'), ' ');
  const targetCell = {
    innerText: '',
    textContent: '',
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 }),
    focus: () => undefined,
    dispatchEvent: () => true
  };
  const hiddenInput = {
    value: '',
    textContent: '',
    getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }),
    focus: () => undefined,
    dispatchEvent: () => true
  };
  const sourceTextBox = {
    id: '',
    disabled: true,
    readOnly: false,
    value: 'Hello world!',
    textContent: ''
  };
  const targetTextBox = {
    id: '',
    disabled: false,
    readOnly: false,
    value: swallowedValue,
    textContent: ''
  };

  globalThis.document = {
    querySelector: () => hiddenInput,
    querySelectorAll: (selector: string) =>
      selector.includes('textarea') ? [sourceTextBox, targetTextBox] : [],
    execCommand: (_command: string, _showDefaultUi?: boolean, insertedValue?: string) => {
      const swallowed = (insertedValue ?? '').replace(new RegExp(NBSP, 'g'), ' ');
      targetCell.innerText = swallowed;
      targetCell.textContent = swallowed;
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => undefined,
      setNativeInputValue: (input: { value: string }, nextValue: string) => {
        input.value = nextValue;
      },
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchTabNavigation: () => undefined,
      dispatchBlur: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '1',
        rowNumber: '1',
        sourceRaw: 'Hello world!',
        sourceNormalized: 'Hello world!',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      value
    );

    assert.equal(outcome.filled, true);
    assert.equal(warnings.length, 1);
    assert.equal(
      /no-break spaces/.test(String(warnings[0]?.[0] ?? '')),
      true
    );
  } finally {
    console.warn = previousWarn;
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment confirms when memoQ preserves the no-break space', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const restoreChrome = installTrustedClickRecorder();
  const previousWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const value = `Bonjour${NBSP}le monde${NBSP}!`;
  const targetCell = {
    innerText: '',
    textContent: '',
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 }),
    focus: () => undefined,
    dispatchEvent: () => true
  };
  const hiddenInput = {
    value: '',
    textContent: '',
    getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }),
    focus: () => undefined,
    dispatchEvent: () => true
  };
  const sourceTextBox = {
    id: '',
    disabled: true,
    readOnly: false,
    value: 'Hello world!',
    textContent: ''
  };
  const targetTextBox = {
    id: '',
    disabled: false,
    readOnly: false,
    value,
    textContent: ''
  };

  globalThis.document = {
    querySelector: () => hiddenInput,
    querySelectorAll: (selector: string) =>
      selector.includes('textarea') ? [sourceTextBox, targetTextBox] : [],
    execCommand: (_command: string, _showDefaultUi?: boolean, insertedValue?: string) => {
      targetCell.innerText = insertedValue ?? '';
      targetCell.textContent = insertedValue ?? '';
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => undefined,
      setNativeInputValue: (input: { value: string }, nextValue: string) => {
        input.value = nextValue;
      },
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchTabNavigation: () => undefined,
      dispatchBlur: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '1',
        rowNumber: '1',
        sourceRaw: 'Hello world!',
        sourceNormalized: 'Hello world!',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      value
    );

    assert.equal(outcome.filled, true);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = previousWarn;
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment requires the normal memoQ hidden input', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { querySelector: () => null } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => undefined,
      setNativeInputValue: () => undefined,
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchTabNavigation: () => undefined,
      dispatchBlur: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '1',
        rowNumber: '1',
        sourceRaw: 'X-Server<1>PWR Rank',
        sourceNormalized: 'X-Server<1>PWR Rank',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['<1>'],
        targetElement: {
          focus: () => undefined,
          matches: () => false,
          querySelectorAll: () => []
        } as never,
        platform: 'memoq'
      },
      'X-Server<1>Rang PWR'
    );

    assert.deepEqual(outcome, {
      domId: '1',
      filled: false,
      reason: 'memoQ hidden input was not found.'
    });
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment writes through the normal memoQ hidden input', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const restoreChrome = installTrustedClickRecorder();
  const calls: string[] = [];
  const targetCell = {
    innerText: '',
    textContent: '',
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 }),
    focus: () => calls.push('focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`target:${event.type}`);
      return true;
    }
  };
  const hiddenInput = {
    value: '',
    textContent: '',
    getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }),
    focus: () => calls.push('hidden-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`hidden:${event.type}`);
      return true;
    }
  };

  globalThis.document = {
    querySelector: () => hiddenInput,
    execCommand: (command: string, _showDefaultUi?: boolean, value?: string) => {
      calls.push(`execCommand:${command}`);
      targetCell.innerText = value ?? '';
      targetCell.textContent = value ?? '';
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => calls.push('mouse'),
      setNativeInputValue: (input: { value: string }, value: string) => {
        calls.push('native-setter');
        input.value = value;
      },
      dispatchInput: () => calls.push('input-helper'),
      dispatchChange: () => calls.push('change-helper'),
      dispatchTabNavigation: () => calls.push('tab-helper'),
      dispatchBlur: () => calls.push('blur-helper')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '1',
        rowNumber: '1',
        sourceRaw: 'X-Server<1>PWR Rank',
        sourceNormalized: 'X-Server<1>PWR Rank',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: ['<1>'],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      'X-Server<1>Rang PWR'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.includes('execCommand:insertText'), true);
    assert.equal(calls.includes('native-setter'), true);
  } finally {
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment confirms against the current memoQ row after row DOM replacement', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const restoreChrome = installTrustedClickRecorder();
  const calls: string[] = [];
  const oldTargetCell = {
    innerText: '',
    textContent: '',
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 }),
    focus: () => calls.push('old-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`old:${event.type}`);
      return true;
    }
  };
  const currentTargetCell = {
    innerText: '',
    textContent: '',
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    focus: () => calls.push('current-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`current:${event.type}`);
      return true;
    },
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 })
  };
  const sourceCell = {
    innerText: 'League Sponsor',
    textContent: 'League Sponsor',
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 120, height: 20, width: 120 })
  };
  const rowNumberCell = {
    innerText: '48.',
    textContent: '48.',
    matches: () => false,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, height: 20, width: 40 })
  };
  const row = {
    id: '',
    parentElement: globalThis.document?.body ?? null,
    children: [rowNumberCell, sourceCell, currentTargetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    getAttribute: () => null
  };
  sourceCell.parentElement = row;
  currentTargetCell.parentElement = row;

  const hiddenInput = {
    value: '',
    textContent: '',
    focus: () => calls.push('hidden-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`hidden:${event.type}`);
      return true;
    }
  };

  globalThis.document = {
    body: {},
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    execCommand: (command: string, _showDefaultUi?: boolean, value?: string) => {
      calls.push(`execCommand:${command}`);
      currentTargetCell.innerText = value ?? '';
      currentTargetCell.textContent = value ?? '';
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => calls.push('mouse'),
      setNativeInputValue: (input: { value: string }, value: string) => {
        calls.push('native-setter');
        input.value = value;
      },
      dispatchInput: () => calls.push('input-helper'),
      dispatchChange: () => calls.push('change-helper'),
      dispatchTabNavigation: () => calls.push('tab-helper'),
      dispatchBlur: () => calls.push('blur-helper')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '48',
        rowNumber: '48',
        sourceRaw: 'League Sponsor',
        sourceNormalized: 'League Sponsor',
        occurrenceIndex: 2,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: oldTargetCell as never,
        platform: 'memoq'
      },
      'Sponsor de Ligue'
    );

    assert.equal(outcome.filled, true);
    assert.equal(oldTargetCell.innerText, '');
    assert.equal(currentTargetCell.innerText, 'Sponsor de Ligue');
  } finally {
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment activates the current memoQ target cell when the scanned target is stale', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const calls: string[] = [];
  let activatedCurrentTarget = false;
  const restoreChrome = installTrustedClickRecorder([], () => {
    activatedCurrentTarget = true;
  });
  const oldTargetCell = {
    innerText: '',
    textContent: '',
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 }),
    focus: () => calls.push('old-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`old:${event.type}`);
      return true;
    }
  };
  const currentTargetCell = {
    innerText: '',
    textContent: '',
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    focus: () => calls.push('current-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`current:${event.type}`);
      if (event.type === 'click') {
        activatedCurrentTarget = true;
      }
      return true;
    },
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 })
  };
  const sourceCell = {
    innerText: 'Relic Inheritor',
    textContent: 'Relic Inheritor',
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 120, height: 20, width: 120 })
  };
  const rowNumberCell = {
    innerText: '54.',
    textContent: '54.',
    matches: () => false,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, height: 20, width: 40 })
  };
  const row = {
    id: '',
    parentElement: globalThis.document?.body ?? null,
    children: [rowNumberCell, sourceCell, currentTargetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    getAttribute: () => null
  };
  sourceCell.parentElement = row;
  currentTargetCell.parentElement = row;

  const hiddenInput = {
    value: '',
    textContent: '',
    focus: () => calls.push('hidden-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`hidden:${event.type}`);
      return true;
    }
  };

  globalThis.document = {
    body: {},
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    execCommand: (command: string, _showDefaultUi?: boolean, value?: string) => {
      calls.push(`execCommand:${command}`);
      if (activatedCurrentTarget) {
        currentTargetCell.innerText = value ?? '';
        currentTargetCell.textContent = value ?? '';
      }
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: (target: { dispatchEvent: (event: Event) => boolean }) => {
        for (const eventName of ['mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new Event(eventName));
        }
      },
      setNativeInputValue: (input: { value: string }, value: string) => {
        calls.push('native-setter');
        input.value = value;
      },
      dispatchInput: () => calls.push('input-helper'),
      dispatchChange: () => calls.push('change-helper'),
      dispatchTabNavigation: () => calls.push('tab-helper'),
      dispatchBlur: () => calls.push('blur-helper')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '54',
        rowNumber: '54',
        sourceRaw: 'Relic Inheritor',
        sourceNormalized: 'Relic Inheritor',
        occurrenceIndex: 2,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: oldTargetCell as never,
        platform: 'memoq'
      },
      'Héritier des reliques'
    );

    assert.equal(outcome.filled, true);
    assert.equal(activatedCurrentTarget, true);
    assert.equal(currentTargetCell.innerText, 'Héritier des reliques');
  } finally {
    restoreChrome();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment activates memoQ targets through trusted background input', async () => {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const calls: string[] = [];
  const messages: unknown[] = [];
  const targetCell = {
    innerText: '',
    textContent: '',
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    focus: () => calls.push('target-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`target:${event.type}`);
      return true;
    },
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left: 260,
      right: 380,
      height: 20,
      width: 120
    })
  };
  const hiddenInput = {
    value: '',
    textContent: '',
    focus: () => calls.push('hidden-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`hidden:${event.type}`);
      return true;
    }
  };

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        messages.push(message);
        callback({ ok: true, data: null });
      }
    }
  };
  globalThis.document = {
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    execCommand: (command: string, _showDefaultUi?: boolean, value?: string) => {
      calls.push(`execCommand:${command}`);
      targetCell.innerText = value ?? '';
      targetCell.textContent = value ?? '';
      return true;
    }
  } as unknown as Document;
  globalThis.window = { setTimeout } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => calls.push('synthetic-mouse'),
      setNativeInputValue: (input: { value: string }, value: string) => {
        calls.push('native-setter');
        input.value = value;
      },
      dispatchInput: () => calls.push('input-helper'),
      dispatchChange: () => calls.push('change-helper'),
      dispatchTabNavigation: () => calls.push('tab-helper'),
      dispatchBlur: () => calls.push('blur-helper')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '65',
        rowNumber: '65',
        sourceRaw: 'Trusted Click',
        sourceNormalized: 'Trusted Click',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      'Clic approuvé'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.includes('synthetic-mouse'), false);
    assert.deepEqual(messages, [
      {
        type: 'MEMOQ_DEBUGGER_PREPARE'
      },
      {
        type: 'MEMOQ_DEBUGGER_CLICK',
        payload: {
          x: 320,
          y: 110
        }
      }
    ]);
  } finally {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment retries the trusted click once when the first write lands nowhere', async () => {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const messages: unknown[] = [];
  let clickCount = 0;
  const targetCell = {
    innerText: '',
    textContent: '',
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    focus: () => undefined,
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left: 260,
      right: 380,
      height: 20,
      width: 120
    })
  };
  const hiddenInput = {
    value: '',
    textContent: '',
    focus: () => undefined,
    dispatchEvent: () => true
  };

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        messages.push(message);
        if ((message as { type?: string }).type === 'MEMOQ_DEBUGGER_CLICK') {
          clickCount += 1;
        }
        callback({ ok: true, data: null });
      }
    }
  };
  globalThis.document = {
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    // The first click misses (grid shifted between measuring and clicking),
    // so the first write goes nowhere; the retried click lands.
    execCommand: (_command: string, _showDefaultUi?: boolean, value?: string) => {
      if (clickCount >= 2) {
        targetCell.innerText = value ?? '';
        targetCell.textContent = value ?? '';
      }
      return true;
    }
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => undefined,
      setNativeInputValue: (input: { value: string }, nextValue: string) => {
        input.value = nextValue;
      },
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchTabNavigation: () => undefined,
      dispatchBlur: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '72',
        rowNumber: '72',
        sourceRaw: 'Retry Click',
        sourceNormalized: 'Retry Click',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      'Clic réessayé'
    );

    assert.equal(outcome.filled, true);
    assert.equal(targetCell.innerText, 'Clic réessayé');
    assert.deepEqual(messages, [
      {
        type: 'MEMOQ_DEBUGGER_PREPARE'
      },
      {
        type: 'MEMOQ_DEBUGGER_CLICK',
        payload: {
          x: 320,
          y: 110
        }
      },
      {
        type: 'MEMOQ_DEBUGGER_CLICK',
        payload: {
          x: 320,
          y: 110
        }
      }
    ]);
  } finally {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.getCurrentEditableValue re-resolves the row instead of trusting the scanned element', () => {
  const previousDocument = globalThis.document;
  const staleTargetCell = {
    innerText: 'Text from a recycled row',
    textContent: 'Text from a recycled row',
    childNodes: [],
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null
  };
  const currentTargetCell = {
    innerText: '',
    textContent: '',
    childNodes: [],
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 })
  };
  const sourceCell = {
    innerText: 'Relic Inheritor',
    textContent: 'Relic Inheritor',
    childNodes: [],
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 120, height: 20, width: 120 })
  };
  const rowNumberCell = {
    innerText: '54.',
    textContent: '54.',
    matches: () => false,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, height: 20, width: 40 })
  };
  const row = {
    id: '',
    parentElement: null as unknown,
    children: [rowNumberCell, sourceCell, currentTargetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : [],
    getAttribute: () => null
  };
  sourceCell.parentElement = row;
  currentTargetCell.parentElement = row;

  globalThis.document = {
    body: {},
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, currentTargetCell] : []
  } as unknown as Document;

  try {
    const adapter = new MemoqAdapter({} as never);

    // The stale element shows another row's text, but the actual row 54
    // target cell is empty — the emptiness check must see the current cell.
    assert.equal(
      adapter.getCurrentEditableValue({
        domId: '54',
        rowNumber: '54',
        sourceRaw: 'Relic Inheritor',
        sourceNormalized: 'Relic Inheritor',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: staleTargetCell as never,
        platform: 'memoq'
      }),
      ''
    );

    // Without a row number there is nothing to re-resolve by; the captured
    // element is still used.
    assert.equal(
      adapter.getCurrentEditableValue({
        domId: 'x',
        rowNumber: undefined,
        sourceRaw: 'Relic Inheritor',
        sourceNormalized: 'Relic Inheritor',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: staleTargetCell as never,
        platform: 'memoq'
      }),
      'Text from a recycled row'
    );
  } finally {
    globalThis.document = previousDocument;
  }
});

test('MemoqAdapter.fillSegment clicks the visible row when a zero-size recycled duplicate shares its row number', async () => {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const messages: unknown[] = [];

  const makeCell = (
    text: string,
    rect: { top: number; bottom: number; left: number; height: number; width: number }
  ) => ({
    innerText: text,
    textContent: text,
    childNodes: [],
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    focus: () => undefined,
    dispatchEvent: () => true,
    getBoundingClientRect: () => rect
  });

  // The recycled node sits earlier in document order and still carries row
  // number 790, but every rect is zero — exactly what a detached virtual row
  // reports.
  const zeroRect = { top: 0, bottom: 0, left: 0, height: 0, width: 0 };
  const staleSourceCell = makeCell('虽然你已经在所有难度', zeroRect);
  const staleTargetCell = makeCell('', zeroRect);
  const liveSourceCell = makeCell('虽然你已经在所有难度', {
    top: 200,
    bottom: 220,
    left: 120,
    height: 20,
    width: 120
  });
  const liveTargetCell = makeCell('', {
    top: 200,
    bottom: 220,
    left: 260,
    height: 20,
    width: 120
  });

  const makeRow = (
    numberText: string,
    cells: Array<ReturnType<typeof makeCell>>
  ) => {
    const rowNumberCell = {
      innerText: numberText,
      textContent: numberText,
      matches: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, height: 0, width: 0 })
    };
    const row = {
      id: '',
      parentElement: null as unknown,
      children: [rowNumberCell, ...cells],
      querySelectorAll: (selector: string) => (selector === '.editor-cell' ? cells : []),
      getAttribute: () => null
    };
    for (const cell of cells) {
      cell.parentElement = row;
    }
    return row;
  };

  makeRow('790.', [staleSourceCell, staleTargetCell]);
  makeRow('790.', [liveSourceCell, liveTargetCell]);

  const hiddenInput = {
    value: '',
    textContent: '',
    focus: () => undefined,
    dispatchEvent: () => true
  };

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        messages.push(message);
        callback({ ok: true, data: null });
      }
    }
  };
  globalThis.document = {
    body: {},
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell'
        ? [staleSourceCell, staleTargetCell, liveSourceCell, liveTargetCell]
        : [],
    execCommand: (_command: string, _showDefaultUi?: boolean, value?: string) => {
      liveTargetCell.innerText = value ?? '';
      liveTargetCell.textContent = value ?? '';
      return true;
    }
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => undefined,
      setNativeInputValue: (input: { value: string }, nextValue: string) => {
        input.value = nextValue;
      },
      dispatchInput: () => undefined,
      dispatchChange: () => undefined,
      dispatchTabNavigation: () => undefined,
      dispatchBlur: () => undefined
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '790',
        rowNumber: '790',
        sourceRaw: '虽然你已经在所有难度',
        sourceNormalized: '虽然你已经在所有难度',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: staleTargetCell as never,
        platform: 'memoq'
      },
      '译文文本'
    );

    assert.equal(outcome.filled, true);
    assert.equal(liveTargetCell.innerText, '译文文本');
    // Coordinates must come from the live row's rect, not the zero-size
    // recycled duplicate.
    assert.deepEqual(messages, [
      {
        type: 'MEMOQ_DEBUGGER_PREPARE'
      },
      {
        type: 'MEMOQ_DEBUGGER_CLICK',
        payload: {
          x: 320,
          y: 210
        }
      }
    ]);
  } finally {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('MemoqAdapter.fillSegment rejects unconfirmed memoQ writes without tabbing to the next row', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousHtmlInputElement = globalThis.HTMLInputElement;
  const previousHtmlTextAreaElement = globalThis.HTMLTextAreaElement;
  const previousWarn = console.warn;
  const restoreChrome = installTrustedClickRecorder();
  const calls: string[] = [];
  const warnings: unknown[][] = [];
  const targetCell = {
    innerText: '',
    textContent: '',
    childNodes: [],
    classList: { contains: () => false },
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => undefined,
    focus: () => calls.push('target-focus'),
    dispatchEvent: (event: Event) => {
      calls.push(`target:${event.type}`);
      return true;
    },
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 260, height: 20, width: 120 })
  };
  const sourceCell = {
    innerText: 'Guide',
    textContent: 'Guide',
    childNodes: [],
    classList: { contains: () => false },
    parentElement: null as unknown,
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 120, height: 20, width: 120 })
  };
  const rowNumberCell = {
    innerText: '60.',
    textContent: '60.',
    matches: () => false,
    getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 40, height: 20, width: 40 })
  };
  const row = {
    id: '',
    parentElement: globalThis.document?.body ?? null,
    children: [rowNumberCell, sourceCell, targetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, targetCell] : [],
    getAttribute: () => null
  };
  sourceCell.parentElement = row;
  targetCell.parentElement = row;

  class TestInput {
    tagName = 'INPUT';
    id = 'editorHiddenInput';
    className = '';
    value = '';
    textContent = '';
    focus(): void {
      calls.push('hidden-focus');
    }
    dispatchEvent(event: Event): boolean {
      calls.push(`hidden:${event.type}`);
      return true;
    }
  }
  const hiddenInput = new TestInput();

  globalThis.HTMLInputElement = TestInput as never;
  globalThis.HTMLTextAreaElement = class TestTextArea extends TestInput {} as never;
  globalThis.document = {
    body: {},
    activeElement: hiddenInput,
    querySelector: (selector: string) =>
      selector === '#editorHiddenInput' ? hiddenInput : null,
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, targetCell] : [],
    execCommand: (command: string, _showDefaultUi?: boolean, value?: string) => {
      calls.push(`execCommand:${command}:${value ?? ''}`);
      return true;
    }
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const adapter = new MemoqAdapter({
      dispatchMouseSequence: () => calls.push('mouse'),
      setNativeInputValue: (input: { value: string }, value: string) => {
        calls.push('native-setter');
        input.value = value;
      },
      dispatchInput: () => calls.push('input-helper'),
      dispatchChange: () => calls.push('change-helper'),
      dispatchTabNavigation: (input: { value: string }) => {
        calls.push('tab-helper');
        input.value = '';
      },
      dispatchBlur: () => calls.push('blur-helper')
    } as never);

    const outcome = await adapter.fillSegment(
      {
        domId: '60',
        rowNumber: '60',
        sourceRaw: 'Guide',
        sourceNormalized: 'Guide',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: targetCell as never,
        platform: 'memoq'
      },
      'Guide'
    );

    assert.equal(outcome.filled, false);
    assert.equal(targetCell.innerText, '');
    assert.equal(calls.includes('tab-helper'), false);
    assert.equal(/Unable to confirm memoQ target update/.test(outcome.reason ?? ''), true);
    assert.equal(warnings.length, 1);
  } finally {
    restoreChrome();
    console.warn = previousWarn;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.HTMLInputElement = previousHtmlInputElement;
    globalThis.HTMLTextAreaElement = previousHtmlTextAreaElement;
  }
});
