import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment, ScrollContext } from '../content-script-dom.ts';
import {
  PlatformRuntime,
  shouldRejectNonEmptyTarget,
  type GientTransRuntimePort,
  type MemoqFillExecutionContext,
  type MemoqRuntimePort,
  type PhraseRuntimePort
} from '../platforms/runtime.ts';

interface NamedScrollContext extends ScrollContext {
  name: string;
}

interface HarnessOptions {
  memoqActive?: boolean;
  memoqSegments?: RuntimeSegment[];
  gientransSegments?: RuntimeSegment[];
  phraseSegments?: RuntimeSegment[];
  memoqScrollContext?: ScrollContext | null;
  gientransScrollContext?: ScrollContext | null;
  phraseScrollContext?: ScrollContext | null;
  gientransValue?: string;
  phraseValue?: string;
}

function makeScrollContext(name: string): NamedScrollContext {
  return {
    name,
    initialTop: 0,
    getTop: () => 0,
    getHeight: () => 100,
    scrollBy: () => undefined,
    scrollToTop: () => undefined,
    isAtBottom: () => false,
    restore: () => undefined
  };
}

function makeSegment(
  platform: RuntimeSegment['platform'],
  domId = platform
): RuntimeSegment {
  return {
    domId,
    sourceRaw: `${platform} source`,
    sourceNormalized: `${platform} source`,
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform
  };
}

function createHarness(options: HarnessOptions = {}): {
  runtime: PlatformRuntime;
  calls: string[];
  memoqContexts: Array<MemoqFillExecutionContext | undefined>;
  fallbackScrollContext: ScrollContext;
} {
  const calls: string[] = [];
  const memoqContexts: Array<MemoqFillExecutionContext | undefined> = [];
  const fallbackScrollContext = makeScrollContext('fallback');

  const memoq: MemoqRuntimePort = {
    isActive: () => {
      calls.push('memoq.isActive');
      return options.memoqActive ?? false;
    },
    findScrollContext: () => {
      calls.push('memoq.findScrollContext');
      return options.memoqScrollContext ?? null;
    },
    collectVisibleSegments: () => {
      calls.push('memoq.collectVisibleSegments');
      return options.memoqSegments ?? [];
    },
    fillSegment: async (segment, _value, context) => {
      calls.push('memoq.fillSegment');
      memoqContexts.push(context);
      return { domId: segment.domId, filled: true };
    },
    prepareTrustedInput: async () => {
      calls.push('memoq.prepareTrustedInput');
    }
  };

  const gientrans: GientTransRuntimePort = {
    findScrollContext: () => {
      calls.push('gientrans.findScrollContext');
      return options.gientransScrollContext ?? null;
    },
    collectVisibleSegments: () => {
      calls.push('gientrans.collectVisibleSegments');
      return options.gientransSegments ?? [];
    },
    getEditableValue: () => {
      calls.push('gientrans.getEditableValue');
      return options.gientransValue ?? '';
    },
    fillSegment: async (segment) => {
      calls.push('gientrans.fillSegment');
      return { domId: segment.domId, filled: true };
    }
  };

  const phrase: PhraseRuntimePort = {
    findScrollContext: () => {
      calls.push('phrase.findScrollContext');
      return options.phraseScrollContext ?? null;
    },
    collectVisibleSegments: () => {
      calls.push('phrase.collectVisibleSegments');
      return options.phraseSegments ?? [];
    },
    getEditableValue: () => {
      calls.push('phrase.getEditableValue');
      return options.phraseValue ?? '';
    },
    fillSegment: async (segment) => {
      calls.push('phrase.fillSegment');
      return { domId: segment.domId, filled: true };
    }
  };

  return {
    runtime: new PlatformRuntime(
      memoq,
      gientrans,
      phrase,
      () => {
        calls.push('fallback.findScrollContext');
        return fallbackScrollContext;
      }
    ),
    calls,
    memoqContexts,
    fallbackScrollContext
  };
}

test('PlatformRuntime selects visible segments in memoQ, GientTrans, Phrase order', () => {
  const scrollContext = makeScrollContext('scan');
  const memoqSegment = makeSegment('memoq');
  const gientransSegment = makeSegment('gientrans');
  const phraseSegment = makeSegment('phrase');

  const memoqHarness = createHarness({
    memoqSegments: [memoqSegment],
    gientransSegments: [gientransSegment],
    phraseSegments: [phraseSegment]
  });
  assert.deepEqual(memoqHarness.runtime.collectVisibleSegments(scrollContext), [memoqSegment]);
  assert.deepEqual(memoqHarness.calls, ['memoq.collectVisibleSegments']);

  const gientransHarness = createHarness({
    gientransSegments: [gientransSegment],
    phraseSegments: [phraseSegment]
  });
  assert.deepEqual(gientransHarness.runtime.collectVisibleSegments(scrollContext), [
    gientransSegment
  ]);
  assert.deepEqual(gientransHarness.calls, [
    'memoq.collectVisibleSegments',
    'gientrans.collectVisibleSegments'
  ]);

  const phraseHarness = createHarness({ phraseSegments: [phraseSegment] });
  assert.deepEqual(phraseHarness.runtime.collectVisibleSegments(scrollContext), [phraseSegment]);
  assert.deepEqual(phraseHarness.calls, [
    'memoq.collectVisibleSegments',
    'gientrans.collectVisibleSegments',
    'phrase.collectVisibleSegments'
  ]);
});

test('PlatformRuntime selects scroll contexts in platform order with a window fallback', () => {
  const phraseScrollContext = makeScrollContext('phrase');
  const phraseHarness = createHarness({ phraseScrollContext });

  assert.equal(phraseHarness.runtime.findScrollContext(), phraseScrollContext);
  assert.deepEqual(phraseHarness.calls, [
    'memoq.findScrollContext',
    'gientrans.findScrollContext',
    'phrase.findScrollContext'
  ]);

  const fallbackHarness = createHarness();
  assert.equal(
    fallbackHarness.runtime.findScrollContext(),
    fallbackHarness.fallbackScrollContext
  );
  assert.deepEqual(fallbackHarness.calls, [
    'memoq.findScrollContext',
    'gientrans.findScrollContext',
    'phrase.findScrollContext',
    'fallback.findScrollContext'
  ]);
});

test('PlatformRuntime keeps memoQ lifecycle and fill context on the memoQ port', async () => {
  const harness = createHarness({ memoqActive: true });
  const segment = makeSegment('memoq');
  const context: MemoqFillExecutionContext = {
    runId: 'run-1',
    sequence: 2,
    scanPass: 3,
    scrollTop: 400,
    scrollMode: 'synthetic'
  };

  assert.equal(harness.runtime.isMemoqActive(), true);
  await harness.runtime.prepareMemoqTrustedInput();
  assert.equal((await harness.runtime.fillSegment(segment, 'translation', context)).filled, true);
  assert.deepEqual(harness.memoqContexts, [context]);
  assert.deepEqual(harness.calls, [
    'memoq.isActive',
    'memoq.prepareTrustedInput',
    'memoq.fillSegment'
  ]);
});

test('PlatformRuntime routes editable reads and fills without crossing platform ports', async () => {
  const harness = createHarness({
    gientransValue: 'existing GientTrans target',
    phraseValue: 'Phrase target'
  });
  const gientransSegment = makeSegment('gientrans');
  const phraseSegment = makeSegment('phrase');
  const genericSegment = makeSegment('generic');

  assert.equal(
    harness.runtime.getEditableValue(gientransSegment),
    'existing GientTrans target'
  );
  assert.equal(harness.runtime.getEditableValue(phraseSegment), 'Phrase target');
  assert.equal(harness.runtime.getEditableValue(genericSegment), 'Phrase target');
  await harness.runtime.fillSegment(gientransSegment, 'GientTrans translation');
  await harness.runtime.fillSegment(phraseSegment, 'Phrase translation');
  await harness.runtime.fillSegment(genericSegment, 'Generic translation');

  assert.deepEqual(harness.calls, [
    'gientrans.getEditableValue',
    'phrase.getEditableValue',
    'phrase.getEditableValue',
    'gientrans.fillSegment',
    'phrase.fillSegment',
    'phrase.fillSegment'
  ]);
});

test('non-empty target protection preserves GientTrans overwrite behavior', () => {
  assert.equal(shouldRejectNonEmptyTarget('gientrans', 'existing target'), false);
  assert.equal(shouldRejectNonEmptyTarget('phrase', 'existing target'), true);
  assert.equal(shouldRejectNonEmptyTarget('generic', 'existing target'), true);
  assert.equal(shouldRejectNonEmptyTarget('phrase', '   '), false);
});
