import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chooseMemoqAccessibilityTextBoxes,
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
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

test('formatMemoqInlineTag converts normal memoQ tag DOM classes to placeholder markup', () => {
  assert.equal(formatMemoqInlineTag('tag inline-empty editor-char', '1'), '<1>');
  assert.equal(formatMemoqInlineTag('tag inline-open editor-char', '2'), '{2>');
  assert.equal(formatMemoqInlineTag('tag inline-close editor-char', '2'), '<2}');
});

test('memoQ accessibility text can be compared with rendered cell text', () => {
  const target = 'Objectif de points atteint<1>Récupérer des récompenses';

  assert.equal(
    memoQAccessibilityTextToRenderedText(target),
    'Objectif de points atteint1Récupérer des récompenses'
  );
  assert.equal(
    isMemoqCommittedTargetText(
      'Objectif de points atteint1Récupérer des récompenses',
      target
    ),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      'Coffre de radiance Coffre de radiance',
      'Coffre de radiance'
    ),
    false
  );
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
