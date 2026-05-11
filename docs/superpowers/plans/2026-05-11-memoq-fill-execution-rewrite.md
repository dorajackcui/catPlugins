# memoQ Fill Execution Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the memoQ fill execution path so one fill run can move downward automatically and accurately fill every safe, matching, empty target segment.

**Architecture:** Keep Excel parsing and source matching intact. Replace the current memoQ fill internals with a verified transaction: locate current row, verify source, verify empty target, perform one trusted browser-input write, confirm the same row, and stop with structured diagnostics on uncertainty. Reuse the existing scan loop only where it remains trustworthy, and re-scan after each successful memoQ fill.

**Tech Stack:** TypeScript, Chrome extension runtime APIs, Chrome debugger protocol, Node test runner with `--experimental-transform-types`, existing `xlsx` dependency.

---

## Scope Check

This plan covers one subsystem: memoQ fill execution. It intentionally does not change Excel parsing, matcher behavior, Phrase filling, or popup layout beyond showing the already-supported stop reason.

## File Structure

- Modify `types.ts`
  - Add stable memoQ fill diagnostic types.
  - Add a debugger write request type.
  - Extend `FillOutcome` with optional `diagnostic`.
- Create `memoq-fill-diagnostics.ts`
  - Keep failure-code-to-message formatting outside DOM code.
  - Provide a small truncation helper for readable stop reasons.
- Modify `background.ts`
  - Replace the memoQ debugger click writer with one trusted debugger write command that clicks and inserts text.
- Modify `memoq-adapter.ts`
  - Keep scanning and source serialization helpers.
  - Delete or rewrite the current memoQ fill internals.
  - Implement the verified fill transaction as the only memoQ write path.
- Modify `content-script.ts`
  - Pass run and scan context into memoQ fill transactions.
  - Preserve automatic downward scanning and re-scan after successful memoQ fills.
- Modify `tests/memoq-accessibility.test.ts`
  - Keep tests for memoQ text serialization and rendered-text comparison.
  - Remove tests that assert old hidden-input and `execCommand` behavior.
- Create `tests/memoq-fill-diagnostics.test.ts`
  - Test diagnostic stop-reason formatting.
- Create `tests/memoq-fill-transaction.test.ts`
  - Test transaction refusal, confirmation, and structured diagnostics.
- Modify `tests/scan-dedupe.test.ts`
  - Keep the existing re-scan-after-memoQ-fill assertion.

Before implementation, run `git status --short` and note the existing dirty tree. Stage only the files listed in each task's commit step.

---

### Task 1: Add Diagnostic Types And Stop-Reason Formatting

**Files:**
- Modify: `types.ts`
- Create: `memoq-fill-diagnostics.ts`
- Test: `tests/memoq-fill-diagnostics.test.ts`

- [ ] **Step 1: Write the failing diagnostic formatting test**

Create `tests/memoq-fill-diagnostics.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeMemoqFillDiagnostic,
  truncateMemoqDiagnosticValue
} from '../memoq-fill-diagnostics.ts';
import type { MemoqFillDiagnostic } from '../types.ts';

test('describeMemoqFillDiagnostic formats a stable stop reason', () => {
  const diagnostic: MemoqFillDiagnostic = {
    outcome: 'failure',
    failureCode: 'SOURCE_MISMATCH',
    runId: 'run-1',
    sequence: 3,
    scanPass: 7,
    scrollTop: 420,
    scrollMode: 'native',
    domId: '15',
    rowNumber: '15',
    locatingMethod: 'rowNumber',
    segmentSource: 'League Sponsor',
    sourceBefore: 'League Sponsor Copy',
    targetBefore: '',
    expectedTranslation: 'Sponsor de ligue',
    activation: {
      attempted: false,
      ok: false
    },
    inputMethod: 'chrome-debugger',
    targetAfter: '',
    confirmation: {
      ok: false,
      attempts: 0
    },
    nearbyRows: [
      {
        rowNumber: '14',
        source: 'Previous',
        target: ''
      },
      {
        rowNumber: '15',
        source: 'League Sponsor Copy',
        target: ''
      }
    ]
  };

  assert.equal(
    describeMemoqFillDiagnostic(diagnostic),
    'Stopped at memoQ row 15: Source changed before writing. Source="League Sponsor Copy"'
  );
});

test('truncateMemoqDiagnosticValue keeps messages readable', () => {
  assert.equal(truncateMemoqDiagnosticValue('Short text'), 'Short text');
  assert.equal(
    truncateMemoqDiagnosticValue('1234567890', 8),
    '12345...'
  );
});
```

- [ ] **Step 2: Run the diagnostic test and verify it fails**

Run:

```bash
node --test --experimental-transform-types tests/memoq-fill-diagnostics.test.ts
```

Expected: FAIL because `memoq-fill-diagnostics.ts` and `MemoqFillDiagnostic` do not exist yet.

- [ ] **Step 3: Add diagnostic types**

In `types.ts`, replace the existing `FillOutcome` block with this expanded block and add the new request type near the current memoQ debugger request:

```ts
export type MemoqFillFailureCode =
  | 'ROW_NOT_FOUND'
  | 'ROW_AMBIGUOUS'
  | 'SOURCE_MISMATCH'
  | 'TARGET_NOT_EMPTY'
  | 'FOCUS_FAILED'
  | 'INPUT_FAILED'
  | 'CONFIRM_TIMEOUT'
  | 'SCROLL_STALLED'
  | 'UNKNOWN_MEMOQ_FILL_ERROR';

export interface MemoqVisibleRowSnapshot {
  rowNumber?: string;
  source: string;
  target: string;
}

export interface MemoqFillDiagnostic {
  outcome: 'success' | 'failure';
  failureCode?: MemoqFillFailureCode;
  runId: string;
  sequence: number;
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
  domId: string;
  rowNumber?: string;
  locatingMethod: 'rowNumber' | 'singleVisibleSource' | 'none';
  segmentSource: string;
  sourceBefore: string;
  targetBefore: string;
  expectedTranslation: string;
  activation: {
    attempted: boolean;
    ok: boolean;
    activeElement?: string;
    error?: string;
  };
  inputMethod: 'chrome-debugger';
  targetAfter: string;
  confirmation: {
    ok: boolean;
    attempts: number;
  };
  nearbyRows: MemoqVisibleRowSnapshot[];
}

export interface FillOutcome {
  domId: string;
  filled: boolean;
  reason?: string;
  diagnostic?: MemoqFillDiagnostic;
}
```

Add this request type in `types.ts`:

```ts
export interface MemoqDebuggerWriteTextRequest {
  type: 'MEMOQ_DEBUGGER_WRITE_TEXT';
  payload: {
    x: number;
    y: number;
    text: string;
  };
}
```

Do not change the `BackgroundRequest` union in this task. Task 2 adds the new request to the union while keeping the old click request temporarily, and Task 6 removes the old click request after the adapter has been rebuilt.

- [ ] **Step 4: Add diagnostic formatting helper**

Create `memoq-fill-diagnostics.ts`:

```ts
import type { MemoqFillDiagnostic, MemoqFillFailureCode } from './types.ts';
import { normalizeText } from './utils.ts';

const FAILURE_MESSAGES: Record<MemoqFillFailureCode, string> = {
  ROW_NOT_FOUND: 'Could not find the current row.',
  ROW_AMBIGUOUS: 'Current row identity is ambiguous.',
  SOURCE_MISMATCH: 'Source changed before writing.',
  TARGET_NOT_EMPTY: 'Target is no longer empty.',
  FOCUS_FAILED: 'Could not activate the memoQ target editor.',
  INPUT_FAILED: 'Trusted text input failed.',
  CONFIRM_TIMEOUT: 'memoQ did not confirm the written target.',
  SCROLL_STALLED: 'memoQ scrolling stopped before the run could continue.',
  UNKNOWN_MEMOQ_FILL_ERROR: 'memoQ fill failed unexpectedly.'
};

export function truncateMemoqDiagnosticValue(value: string, maxLength = 120): string {
  const normalized = normalizeText(value);
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

export function describeMemoqFillDiagnostic(diagnostic: MemoqFillDiagnostic): string {
  const rowLabel = diagnostic.rowNumber
    ? `row ${diagnostic.rowNumber}`
    : `segment ${diagnostic.domId}`;
  const message = diagnostic.failureCode
    ? FAILURE_MESSAGES[diagnostic.failureCode]
    : 'memoQ fill stopped.';
  const source = diagnostic.sourceBefore || diagnostic.segmentSource;

  return `Stopped at memoQ ${rowLabel}: ${message} Source="${truncateMemoqDiagnosticValue(source)}"`;
}
```

- [ ] **Step 5: Run the diagnostic test and typecheck**

Run:

```bash
node --test --experimental-transform-types tests/memoq-fill-diagnostics.test.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add types.ts memoq-fill-diagnostics.ts tests/memoq-fill-diagnostics.test.ts
git commit -m "Add memoQ fill diagnostics model"
```

---

### Task 2: Add One Trusted Debugger Write Command

**Files:**
- Modify: `types.ts`
- Modify: `background.ts`

- [ ] **Step 1: Update the background debugger writer**

In `background.ts`, replace `dispatchTrustedTabClick` with this function:

```ts
async function dispatchTrustedMemoqWrite(
  tabId: number,
  x: number,
  y: number,
  text: string
): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
    throw new Error('Invalid memoQ trusted write payload.');
  }

  const target = { tabId };
  let attached = false;

  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(target, CHROME_DEBUGGER_PROTOCOL_VERSION, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        attached = true;
        resolve();
      });
    });

    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await new Promise<void>((resolve, reject) => {
        chrome.debugger.sendCommand(
          target,
          'Input.dispatchMouseEvent',
          {
            type,
            x,
            y,
            button: 'left',
            clickCount: 1
          },
          () => {
            const error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }

            resolve();
          }
        );
      });
    }

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.sendCommand(
        target,
        'Input.insertText',
        { text },
        () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        }
      );
    });
  } finally {
    if (attached) {
      await new Promise<void>((resolve) => {
        chrome.debugger.detach(target, () => {
          resolve();
        });
      });
    }
  }
}
```

- [ ] **Step 2: Replace the background message case**

In `handleMessage`, replace the `MEMOQ_DEBUGGER_CLICK` case with:

```ts
    case 'MEMOQ_DEBUGGER_WRITE_TEXT': {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        throw new Error('memoQ trusted write requires a sender tab.');
      }

      await dispatchTrustedMemoqWrite(
        tabId,
        request.payload.x,
        request.payload.y,
        request.payload.text
      );
      return { ok: true, data: null };
    }
```

- [ ] **Step 3: Add the write request to the background union**

Keep `MemoqDebuggerClickRequest` temporarily so the current adapter still typechecks until Task 4 replaces it. Update the `BackgroundRequest` union to include both request types:

```ts
export type BackgroundRequest =
  | ParseExcelRequest
  | RunPreviewRequest
  | RunFillRequest
  | ExportSourcesRequest
  | StopRunRequest
  | GetStateRequest
  | SetFillOptionsRequest
  | ReportRunProgressRequest
  | MemoqDebuggerClickRequest
  | MemoqDebuggerWriteTextRequest;
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS. The codebase temporarily supports both old click and new write requests until Task 6 removes the old path.

- [ ] **Step 5: Commit**

Commit the new trusted write command while the old click request still exists:

```bash
git add types.ts background.ts
git commit -m "Use trusted debugger text input for memoQ"
```

---

### Task 3: Write Transaction Tests For The New Fill Path

**Files:**
- Create: `tests/memoq-fill-transaction.test.ts`
- Modify: `tests/memoq-accessibility.test.ts`

- [ ] **Step 1: Remove old fill-behavior tests from accessibility test**

In `tests/memoq-accessibility.test.ts`, keep only tests for:

```ts
shouldUseMemoqAccessibilityTextBox
chooseMemoqAccessibilityTextBoxes
formatMemoqInlineTag
memoQAccessibilityTextToRenderedText
isMemoqCommittedTargetText
```

Delete tests that assert:

```ts
MemoqAdapter.fillSegment requires the normal memoQ hidden input
MemoqAdapter.fillSegment writes through the normal memoQ hidden input
MemoqAdapter.fillSegment confirms against the current memoQ row after row DOM replacement
MemoqAdapter.fillSegment activates the current memoQ target cell when the scanned target is stale
MemoqAdapter.fillSegment activates memoQ targets through trusted background input
MemoqAdapter.fillSegment rejects unconfirmed memoQ writes without tabbing to the next row
```

- [ ] **Step 2: Write failing transaction tests**

Create `tests/memoq-fill-transaction.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoqAdapter } from '../memoq-adapter.ts';
import type { RuntimeSegment } from '../content-script-dom.ts';

type FakeCell = {
  innerText: string;
  textContent: string;
  parentElement: FakeRow | null;
  childNodes: unknown[];
  classList: { contains: (name: string) => boolean };
  matches: (selector: string) => boolean;
  querySelector: () => null;
  scrollIntoView: () => void;
  getBoundingClientRect: () => {
    top: number;
    bottom: number;
    left: number;
    right: number;
    height: number;
    width: number;
  };
};

type FakeRow = {
  id: string;
  parentElement: unknown;
  children: unknown[];
  querySelectorAll: (selector: string) => FakeCell[];
  getAttribute: (name: string) => string | null;
};

function createCell(text: string, left: number): FakeCell {
  return {
    innerText: text,
    textContent: text,
    parentElement: null,
    childNodes: [],
    classList: { contains: () => false },
    matches: (selector: string) => selector === '.editor-cell',
    querySelector: () => null,
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 120,
      left,
      right: left + 120,
      height: 20,
      width: 120
    })
  };
}

function createRow(rowNumber: string, source: string, target: string): {
  row: FakeRow;
  rowNumberCell: { innerText: string; textContent: string; matches: () => false };
  sourceCell: FakeCell;
  targetCell: FakeCell;
} {
  const rowNumberCell = {
    innerText: `${rowNumber}.`,
    textContent: `${rowNumber}.`,
    matches: () => false
  };
  const sourceCell = createCell(source, 120);
  const targetCell = createCell(target, 280);
  const row: FakeRow = {
    id: '',
    parentElement: {},
    children: [rowNumberCell, sourceCell, targetCell],
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell' ? [sourceCell, targetCell] : [],
    getAttribute: () => null
  };

  sourceCell.parentElement = row;
  targetCell.parentElement = row;

  return { row, rowNumberCell, sourceCell, targetCell };
}

function createSegment(rowNumber: string, source: string, targetCell: FakeCell): RuntimeSegment {
  return {
    domId: rowNumber,
    rowNumber,
    sourceRaw: source,
    sourceNormalized: source,
    occurrenceIndex: 1,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: targetCell as never,
    platform: 'memoq'
  };
}

function installDocument(rows: ReturnType<typeof createRow>[]): () => void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  globalThis.document = {
    body: {},
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: (selector: string) =>
      selector === '.editor-cell'
        ? rows.flatMap(({ sourceCell, targetCell }) => [sourceCell, targetCell])
        : []
  } as unknown as Document;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    }
  } as unknown as Window & typeof globalThis;

  return () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
}

function installTrustedWriter(
  onWrite: (message: unknown) => void
): () => void {
  const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;

  (globalThis as typeof globalThis & { chrome?: unknown }).chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message: unknown, callback: (response: unknown) => void) => {
        onWrite(message);
        callback({ ok: true, data: null });
      }
    }
  };

  return () => {
    (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
  };
}

function createAdapter(): MemoqAdapter {
  return new MemoqAdapter({
    sortByVisualPosition: <T>(items: T[]) => items,
    isElementVisible: () => true,
    getAbsoluteTop: () => 100,
    findBestScrollContainer: () => null,
    toElementScrollContext: () => {
      throw new Error('unused');
    },
    dispatchMouseSequence: () => undefined,
    setNativeInputValue: () => undefined,
    dispatchInput: () => undefined,
    dispatchChange: () => undefined,
    dispatchTabNavigation: () => undefined,
    dispatchBlur: () => undefined
  } as never);
}

test('memoQ fill refuses to write when the row is missing', async () => {
  const row = createRow('10', 'League Sponsor', '');
  const restoreDocument = installDocument([]);

  try {
    const outcome = await createAdapter().fillSegment(
      createSegment('10', 'League Sponsor', row.targetCell),
      'Sponsor de ligue',
      {
        runId: 'run-1',
        sequence: 1,
        scanPass: 2,
        scrollTop: 0,
        scrollMode: 'native'
      }
    );

    assert.equal(outcome.filled, false);
    assert.equal(outcome.diagnostic?.failureCode, 'ROW_NOT_FOUND');
  } finally {
    restoreDocument();
  }
});

test('memoQ fill refuses to write when the source changed', async () => {
  const row = createRow('10', 'League Sponsor Copy', '');
  const restoreDocument = installDocument([row]);

  try {
    const outcome = await createAdapter().fillSegment(
      createSegment('10', 'League Sponsor', row.targetCell),
      'Sponsor de ligue',
      {
        runId: 'run-1',
        sequence: 1,
        scanPass: 2,
        scrollTop: 0,
        scrollMode: 'native'
      }
    );

    assert.equal(outcome.filled, false);
    assert.equal(outcome.diagnostic?.failureCode, 'SOURCE_MISMATCH');
    assert.equal(outcome.diagnostic?.sourceBefore, 'League Sponsor Copy');
  } finally {
    restoreDocument();
  }
});

test('memoQ fill refuses to write when the target is no longer empty', async () => {
  const row = createRow('10', 'League Sponsor', 'Existing target');
  const restoreDocument = installDocument([row]);

  try {
    const outcome = await createAdapter().fillSegment(
      createSegment('10', 'League Sponsor', row.targetCell),
      'Sponsor de ligue',
      {
        runId: 'run-1',
        sequence: 1,
        scanPass: 2,
        scrollTop: 0,
        scrollMode: 'native'
      }
    );

    assert.equal(outcome.filled, false);
    assert.equal(outcome.diagnostic?.failureCode, 'TARGET_NOT_EMPTY');
  } finally {
    restoreDocument();
  }
});

test('memoQ fill writes through one trusted debugger message and confirms the same row', async () => {
  const row = createRow('10', 'League Sponsor', '');
  const messages: unknown[] = [];
  const restoreDocument = installDocument([row]);
  const restoreChrome = installTrustedWriter((message) => {
    messages.push(message);
    row.targetCell.innerText = 'Sponsor de ligue';
    row.targetCell.textContent = 'Sponsor de ligue';
  });

  try {
    const outcome = await createAdapter().fillSegment(
      createSegment('10', 'League Sponsor', row.targetCell),
      'Sponsor de ligue',
      {
        runId: 'run-1',
        sequence: 1,
        scanPass: 2,
        scrollTop: 0,
        scrollMode: 'native'
      }
    );

    assert.equal(outcome.filled, true);
    assert.equal(outcome.diagnostic?.outcome, 'success');
    assert.deepEqual(messages, [
      {
        type: 'MEMOQ_DEBUGGER_WRITE_TEXT',
        payload: {
          x: 340,
          y: 110,
          text: 'Sponsor de ligue'
        }
      }
    ]);
  } finally {
    restoreChrome();
    restoreDocument();
  }
});

test('memoQ fill returns confirmation diagnostics with nearby rows', async () => {
  const previous = createRow('9', 'Previous', '');
  const row = createRow('10', 'League Sponsor', '');
  const next = createRow('11', 'Next', '');
  const restoreDocument = installDocument([previous, row, next]);
  const restoreChrome = installTrustedWriter(() => undefined);

  try {
    const outcome = await createAdapter().fillSegment(
      createSegment('10', 'League Sponsor', row.targetCell),
      'Sponsor de ligue',
      {
        runId: 'run-1',
        sequence: 1,
        scanPass: 2,
        scrollTop: 0,
        scrollMode: 'native'
      }
    );

    assert.equal(outcome.filled, false);
    assert.equal(outcome.diagnostic?.failureCode, 'CONFIRM_TIMEOUT');
    assert.deepEqual(
      outcome.diagnostic?.nearbyRows.map((snapshot) => snapshot.rowNumber),
      ['9', '10', '11']
    );
  } finally {
    restoreChrome();
    restoreDocument();
  }
});
```

- [ ] **Step 3: Run the transaction tests and verify they fail**

Run:

```bash
node --test --experimental-transform-types tests/memoq-fill-transaction.test.ts
```

Expected: FAIL because `MemoqAdapter.fillSegment` does not accept the context argument and does not return structured diagnostics yet.

- [ ] **Step 4: Commit tests after Task 4 passes**

Do not commit these tests while they fail. After Task 4 passes:

```bash
git add tests/memoq-fill-transaction.test.ts tests/memoq-accessibility.test.ts
git commit -m "Test memoQ verified fill transactions"
```

---

### Task 4: Rebuild `MemoqAdapter.fillSegment` As A Verified Transaction

**Files:**
- Modify: `memoq-adapter.ts`
- Modify: `types.ts`
- Test: `tests/memoq-fill-transaction.test.ts`
- Test: `tests/memoq-accessibility.test.ts`

- [ ] **Step 1: Replace old fill constants and internal result types**

In `memoq-adapter.ts`, remove these old names:

```ts
MEMOQ_HIDDEN_INPUT_SELECTOR
MemoqCommitWaitResult
buildMemoqFillFailureReason
waitForCommittedTargetCellText
describeActiveElement
dispatchTrustedMouseClick
```

Keep these helpers because they support scanning or confirmation:

```ts
formatMemoqInlineTag
memoQAccessibilityTextToRenderedText
isMemoqCommittedTargetText
serializeMemoqContent
extractMemoqRowNumber
extractMemoqRowNumberWithoutScrollContext
findMemoqRowContainer
```

Add these constants and context type near the top of `memoq-adapter.ts`:

```ts
const MEMOQ_CONFIRM_ATTEMPTS = 10;
const MEMOQ_CONFIRM_DELAY_MS = 120;
const MEMOQ_ACTIVATION_SETTLE_MS = 80;
const MEMOQ_NEARBY_ROW_RADIUS = 2;

export interface MemoqFillContext {
  runId: string;
  sequence: number;
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
}
```

- [ ] **Step 2: Add current-row resolution helpers**

Add these private helpers inside `MemoqAdapter`:

```ts
  private resolveCurrentMemoqRow(segment: RuntimeSegment): {
    row: HTMLElement;
    sourceCell: HTMLElement;
    targetCell: HTMLElement;
    rowNumber?: string;
    locatingMethod: 'rowNumber' | 'singleVisibleSource';
  } | null | 'ambiguous' {
    const visibleRows = this.collectCurrentVisibleRows();

    if (segment.rowNumber) {
      const matches = visibleRows.filter((row) => row.rowNumber === segment.rowNumber);
      if (matches.length === 1) {
        return {
          ...matches[0],
          locatingMethod: 'rowNumber'
        };
      }

      return matches.length > 1 ? 'ambiguous' : null;
    }

    const sourceMatches = visibleRows.filter(
      (row) => normalizeText(this.getEditableValue(row.sourceCell)) === segment.sourceNormalized
    );

    if (sourceMatches.length === 1) {
      return {
        ...sourceMatches[0],
        locatingMethod: 'singleVisibleSource'
      };
    }

    return sourceMatches.length > 1 ? 'ambiguous' : null;
  }

  private collectCurrentVisibleRows(): Array<{
    row: HTMLElement;
    sourceCell: HTMLElement;
    targetCell: HTMLElement;
    rowNumber?: string;
  }> {
    if (typeof document.querySelectorAll !== 'function') {
      return [];
    }

    const rows: Array<{
      row: HTMLElement;
      sourceCell: HTMLElement;
      targetCell: HTMLElement;
      rowNumber?: string;
    }> = [];
    const seenRows = new Set<HTMLElement>();

    for (const cell of Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))) {
      const row = this.findMemoqRowContainer(cell);
      if (!row || seenRows.has(row)) {
        continue;
      }

      seenRows.add(row);
      const cells = Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR))
        .sort((left, right) =>
          left.getBoundingClientRect().left - right.getBoundingClientRect().left
        );

      if (cells.length >= 2) {
        rows.push({
          row,
          sourceCell: cells[0],
          targetCell: cells[cells.length - 1],
          rowNumber: this.extractMemoqRowNumberWithoutScrollContext(row)
        });
      }
    }

    return rows;
  }
```

- [ ] **Step 3: Add diagnostic and failure helpers**

Add these private helpers inside `MemoqAdapter`:

```ts
  private createBaseDiagnostic(
    segment: RuntimeSegment,
    value: string,
    context: MemoqFillContext
  ): MemoqFillDiagnostic {
    return {
      outcome: 'failure',
      runId: context.runId,
      sequence: context.sequence,
      scanPass: context.scanPass,
      scrollTop: context.scrollTop,
      scrollMode: context.scrollMode,
      domId: segment.domId,
      rowNumber: segment.rowNumber,
      locatingMethod: 'none',
      segmentSource: segment.sourceRaw,
      sourceBefore: '',
      targetBefore: '',
      expectedTranslation: value,
      activation: {
        attempted: false,
        ok: false
      },
      inputMethod: 'chrome-debugger',
      targetAfter: '',
      confirmation: {
        ok: false,
        attempts: 0
      },
      nearbyRows: this.collectNearbyVisibleRows(segment.rowNumber)
    };
  }

  private failMemoqFill(
    segment: RuntimeSegment,
    diagnostic: MemoqFillDiagnostic,
    failureCode: MemoqFillFailureCode
  ): FillOutcome {
    const failedDiagnostic = {
      ...diagnostic,
      outcome: 'failure' as const,
      failureCode,
      nearbyRows: this.collectNearbyVisibleRows(segment.rowNumber)
    };
    const reason = describeMemoqFillDiagnostic(failedDiagnostic);

    console.warn('[Phrase Bulk Fill] memoQ fill failed', failedDiagnostic);

    return {
      domId: segment.domId,
      filled: false,
      reason,
      diagnostic: failedDiagnostic
    };
  }

  private collectNearbyVisibleRows(rowNumber?: string): MemoqVisibleRowSnapshot[] {
    const snapshots = this.collectCurrentVisibleRows().map((row) => ({
      rowNumber: row.rowNumber,
      source: this.getEditableValue(row.sourceCell),
      target: this.getEditableValue(row.targetCell)
    }));

    if (!rowNumber) {
      return snapshots.slice(-5);
    }

    const index = snapshots.findIndex((snapshot) => snapshot.rowNumber === rowNumber);
    if (index === -1) {
      return snapshots.slice(-5);
    }

    return snapshots.slice(
      Math.max(0, index - MEMOQ_NEARBY_ROW_RADIUS),
      index + MEMOQ_NEARBY_ROW_RADIUS + 1
    );
  }
```

Also import the new items at the top:

```ts
import { describeMemoqFillDiagnostic } from './memoq-fill-diagnostics.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  FillOutcome,
  MemoqFillDiagnostic,
  MemoqFillFailureCode,
  MemoqVisibleRowSnapshot
} from './types.ts';
```

- [ ] **Step 4: Add one trusted writer helper**

Add this private helper inside `MemoqAdapter`:

```ts
  private async trustedWriteTargetText(
    targetCell: HTMLElement,
    value: string
  ): Promise<void> {
    targetCell.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await delay(MEMOQ_ACTIVATION_SETTLE_MS);

    const rect = targetCell.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('memoQ target cell is not visible enough to write.');
    }

    const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_WRITE_TEXT',
      payload: {
        x,
        y,
        text: value
      }
    });

    if (!response.ok) {
      throw new Error(response.error);
    }
  }
```

- [ ] **Step 5: Add same-row confirmation helper**

Add this private helper inside `MemoqAdapter`:

```ts
  private async waitForSameRowConfirmation(
    segment: RuntimeSegment,
    value: string
  ): Promise<{ ok: boolean; attempts: number; targetAfter: string }> {
    let targetAfter = '';

    for (let attempt = 1; attempt <= MEMOQ_CONFIRM_ATTEMPTS; attempt += 1) {
      const resolved = this.resolveCurrentMemoqRow(segment);
      if (!resolved || resolved === 'ambiguous') {
        return {
          ok: false,
          attempts: attempt,
          targetAfter
        };
      }

      targetAfter = this.getEditableValue(resolved.targetCell);
      if (isMemoqCommittedTargetText(targetAfter, value)) {
        return {
          ok: true,
          attempts: attempt,
          targetAfter
        };
      }

      if (attempt < MEMOQ_CONFIRM_ATTEMPTS) {
        await delay(MEMOQ_CONFIRM_DELAY_MS);
      }
    }

    return {
      ok: false,
      attempts: MEMOQ_CONFIRM_ATTEMPTS,
      targetAfter
    };
  }
```

- [ ] **Step 6: Replace `fillSegment` with the new transaction**

Replace `MemoqAdapter.fillSegment` with:

```ts
  async fillSegment(
    segment: RuntimeSegment,
    value: string,
    context: MemoqFillContext = {
      runId: 'unknown',
      sequence: 0,
      scanPass: 0,
      scrollTop: 0,
      scrollMode: 'native'
    }
  ): Promise<FillOutcome> {
    const diagnostic = this.createBaseDiagnostic(segment, value, context);

    try {
      const resolved = this.resolveCurrentMemoqRow(segment);
      if (!resolved) {
        return this.failMemoqFill(segment, diagnostic, 'ROW_NOT_FOUND');
      }
      if (resolved === 'ambiguous') {
        return this.failMemoqFill(segment, diagnostic, 'ROW_AMBIGUOUS');
      }

      diagnostic.locatingMethod = resolved.locatingMethod;
      diagnostic.rowNumber = resolved.rowNumber ?? diagnostic.rowNumber;
      diagnostic.sourceBefore = this.getEditableValue(resolved.sourceCell);
      diagnostic.targetBefore = this.getEditableValue(resolved.targetCell);

      if (normalizeText(diagnostic.sourceBefore) !== segment.sourceNormalized) {
        return this.failMemoqFill(segment, diagnostic, 'SOURCE_MISMATCH');
      }

      if (normalizeText(diagnostic.targetBefore) !== '') {
        return this.failMemoqFill(segment, diagnostic, 'TARGET_NOT_EMPTY');
      }

      diagnostic.activation = {
        attempted: true,
        ok: false
      };

      try {
        await this.trustedWriteTargetText(resolved.targetCell, value);
        diagnostic.activation = {
          attempted: true,
          ok: true,
          activeElement: this.describeCurrentActiveElement()
        };
      } catch (error) {
        diagnostic.activation = {
          attempted: true,
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown activation error.'
        };
        return this.failMemoqFill(segment, diagnostic, 'INPUT_FAILED');
      }

      const confirmation = await this.waitForSameRowConfirmation(segment, value);
      diagnostic.confirmation = {
        ok: confirmation.ok,
        attempts: confirmation.attempts
      };
      diagnostic.targetAfter = confirmation.targetAfter;

      if (!confirmation.ok) {
        return this.failMemoqFill(segment, diagnostic, 'CONFIRM_TIMEOUT');
      }

      const successDiagnostic: MemoqFillDiagnostic = {
        ...diagnostic,
        outcome: 'success',
        failureCode: undefined,
        nearbyRows: this.collectNearbyVisibleRows(diagnostic.rowNumber)
      };

      console.info('[Phrase Bulk Fill] memoQ fill succeeded', successDiagnostic);

      return {
        domId: segment.domId,
        filled: true,
        diagnostic: successDiagnostic
      };
    } catch (error) {
      diagnostic.activation.error =
        error instanceof Error ? error.message : 'Unknown memoQ fill error.';
      return this.failMemoqFill(segment, diagnostic, 'UNKNOWN_MEMOQ_FILL_ERROR');
    }
  }
```

Add this active-element helper:

```ts
  private describeCurrentActiveElement(): string {
    const activeElement = document.activeElement as HTMLElement | null;
    if (!activeElement) {
      return 'none';
    }

    return `${activeElement.tagName.toLowerCase()}#${activeElement.id || ''}.${String(activeElement.className || '').replace(/\s+/g, '.')}`;
  }
```

- [ ] **Step 7: Run transaction and accessibility tests**

Run:

```bash
node --test --experimental-transform-types tests/memoq-fill-transaction.test.ts tests/memoq-accessibility.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS after Task 2 and Task 4 are both wired.

- [ ] **Step 9: Commit**

```bash
git add memoq-adapter.ts types.ts background.ts tests/memoq-fill-transaction.test.ts tests/memoq-accessibility.test.ts
git commit -m "Rebuild memoQ fill transaction"
```

---

### Task 5: Pass Run And Scan Context From The Fill Loop

**Files:**
- Modify: `content-script.ts`
- Test: `tests/scan-dedupe.test.ts`

- [ ] **Step 1: Extend the segment callback context**

In `content-script.ts`, add this internal interface above `class PlatformDomAdapter`:

```ts
interface SegmentVisitContext {
  pass: number;
  visibleIndex: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
}
```

Change the `collectSegments` callback type from:

```ts
onSegment?: (
  segment: RuntimeSegment
) => Promise<'stop' | 'rescan' | void> | 'stop' | 'rescan' | void,
```

to:

```ts
onSegment?: (
  segment: RuntimeSegment,
  context: SegmentVisitContext
) => Promise<'stop' | 'rescan' | void> | 'stop' | 'rescan' | void,
```

- [ ] **Step 2: Pass context while scanning**

Inside the `for (const segment of visibleSegments)` loop, change it to:

```ts
        for (let visibleIndex = 0; visibleIndex < visibleSegments.length; visibleIndex += 1) {
          const segment = visibleSegments[visibleIndex];
          this.assertNotStopped();
```

Replace the callback invocation with:

```ts
            const callbackResult = await onSegment(segment, {
              pass,
              visibleIndex,
              scrollTop: scrollContext.getTop(),
              scrollMode: scrollContext.mode ?? 'native'
            });
```

- [ ] **Step 3: Pass context into memoQ fill**

Change the `fillAll` callback signature to:

```ts
      async (segment, visitContext) => {
```

Change the fill call from:

```ts
const outcome = await this.fillSegment(segment, item.translation);
```

to:

```ts
const outcome = await this.fillSegment(
  segment,
  item.translation,
  runId,
  filledDomIds.length + 1,
  visitContext
);
```

Change the private `fillSegment` signature to:

```ts
  private async fillSegment(
    segment: RuntimeSegment,
    value: string,
    runId: string,
    sequence: number,
    visitContext: SegmentVisitContext
  ): Promise<FillOutcome> {
```

Inside that method, keep the current target-empty pre-check for all platforms, then change the memoQ call to:

```ts
    if (segment.platform === 'memoq') {
      return memoqAdapter.fillSegment(segment, value, {
        runId,
        sequence,
        scanPass: visitContext.pass,
        scrollTop: visitContext.scrollTop,
        scrollMode: visitContext.scrollMode
      });
    }
```

- [ ] **Step 4: Keep memoQ re-scan behavior explicit**

Leave this behavior intact:

```ts
shouldRescanVisibleSnapshot = shouldRescanAfterSegmentFill(segment, outcome);
```

Keep `tests/scan-dedupe.test.ts` asserting:

```ts
test('memoQ fills rescan before using the rest of a visible-row snapshot', () => {
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'memoq' }, { filled: true }),
    true
  );
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'phrase' }, { filled: true }),
    false
  );
  assert.equal(
    shouldRescanAfterSegmentFill({ platform: 'memoq' }, { filled: false }),
    false
  );
});
```

- [ ] **Step 5: Run targeted tests and typecheck**

Run:

```bash
node --test --experimental-transform-types tests/scan-dedupe.test.ts tests/memoq-fill-transaction.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add content-script.ts tests/scan-dedupe.test.ts
git commit -m "Pass memoQ fill context from scan loop"
```

---

### Task 6: Clean Out Old memoQ Fill Internals

**Files:**
- Modify: `memoq-adapter.ts`
- Modify: `types.ts`
- Modify: `background.ts`
- Modify: `tests/memoq-accessibility.test.ts`

- [ ] **Step 1: Search for old fill mechanisms**

Run:

```bash
rg -n "execCommand|ClipboardEvent|editorHiddenInput|dispatchTabNavigation|buildMemoqFillFailureReason|waitForCommittedTargetCellText|MEMOQ_DEBUGGER_CLICK" memoq-adapter.ts tests
```

Expected before cleanup: any remaining matches identify old fill execution code or obsolete tests.

- [ ] **Step 2: Remove old fill execution code**

Delete old memoQ fill execution branches that:

```ts
document.execCommand('insertText', false, value)
new ClipboardEvent('paste', ...)
this.helpers.setNativeInputValue(hiddenInput, value)
this.helpers.dispatchInput(hiddenInput, value, true)
this.helpers.dispatchChange(hiddenInput)
this.helpers.dispatchBlur(hiddenInput)
```

Keep `MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR` and accessibility textbox helpers only if scanning or text comparison still uses them.

- [ ] **Step 3: Remove the old debugger click request**

Delete `MemoqDebuggerClickRequest` from `types.ts`, remove it from `BackgroundRequest`, and delete the `MEMOQ_DEBUGGER_CLICK` case from `background.ts`. The remaining memoQ debugger request union should be:

```ts
export type BackgroundRequest =
  | ParseExcelRequest
  | RunPreviewRequest
  | RunFillRequest
  | ExportSourcesRequest
  | StopRunRequest
  | GetStateRequest
  | SetFillOptionsRequest
  | ReportRunProgressRequest
  | MemoqDebuggerWriteTextRequest;
```

- [ ] **Step 4: Verify only trusted write remains**

Run:

```bash
rg -n "execCommand|ClipboardEvent|editorHiddenInput|dispatchTabNavigation|buildMemoqFillFailureReason|waitForCommittedTargetCellText|MEMOQ_DEBUGGER_CLICK" memoq-adapter.ts tests
```

Expected: no output from `memoq-adapter.ts`; tests may mention `dispatchTabNavigation` only in generic helper mocks if those mocks are still required by the adapter constructor type.

- [ ] **Step 5: Run memoQ tests**

Run:

```bash
node --test --experimental-transform-types tests/memoq-fill-diagnostics.test.ts tests/memoq-fill-transaction.test.ts tests/memoq-accessibility.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add memoq-adapter.ts types.ts background.ts tests/memoq-accessibility.test.ts
git commit -m "Remove old memoQ fill internals"
```

---

### Task 7: Full Verification And Build

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run all unit tests**

Run:

```bash
npm test
```

Expected: PASS for all tests.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Build the extension**

Run:

```bash
npm run build
```

Expected: PASS and generated extension output completes without TypeScript or bundling errors.

- [ ] **Step 4: Final source audit**

Run:

```bash
rg -n "MEMOQ_DEBUGGER_WRITE_TEXT|execCommand|ClipboardEvent|editorHiddenInput|CONFIRM_TIMEOUT|SOURCE_MISMATCH|TARGET_NOT_EMPTY|ROW_NOT_FOUND" memoq-adapter.ts background.ts types.ts tests
```

Expected:

```text
MEMOQ_DEBUGGER_WRITE_TEXT appears in types.ts, background.ts, memoq-adapter.ts, and tests.
CONFIRM_TIMEOUT, SOURCE_MISMATCH, TARGET_NOT_EMPTY, and ROW_NOT_FOUND appear in diagnostic types/tests.
execCommand, ClipboardEvent, and editorHiddenInput do not appear in memoq-adapter.ts.
```

- [ ] **Step 5: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- memoq-adapter.ts content-script.ts background.ts types.ts memoq-fill-diagnostics.ts tests/memoq-fill-transaction.test.ts tests/memoq-fill-diagnostics.test.ts tests/memoq-accessibility.test.ts
```

Expected: diff shows a rebuilt memoQ fill execution path, diagnostic model, one trusted write path, and tests for failure categories.

- [ ] **Step 6: Commit final verification adjustments**

If Step 1 through Step 5 required small fixes, commit them:

```bash
git add memoq-adapter.ts content-script.ts background.ts types.ts memoq-fill-diagnostics.ts tests/memoq-fill-transaction.test.ts tests/memoq-fill-diagnostics.test.ts tests/memoq-accessibility.test.ts tests/scan-dedupe.test.ts
git commit -m "Verify memoQ fill rewrite"
```

If no files changed after the previous commits, skip this commit.

---

## Self-Review

- Spec coverage:
  - Rebuild rather than repair: Task 4 and Task 6 delete or rewrite old fill internals.
  - One main input path: Task 2 and Task 4 use `MEMOQ_DEBUGGER_WRITE_TEXT`.
  - Source matching unchanged: no task modifies `excel.ts` or `matcher.ts`.
  - Automatic downward filling: Task 5 preserves the existing scan loop and explicit memoQ re-scan after success.
  - Failure stops with diagnostics: Task 1, Task 3, and Task 4 add structured diagnostic failures.
  - Clean implementation: Task 6 audits and removes old hidden-input, paste, and `execCommand` paths.
- Placeholder scan:
  - No deferred sections, missing commands, or unnamed tests.
- Type consistency:
  - `MemoqFillDiagnostic`, `MemoqFillFailureCode`, `MemoqVisibleRowSnapshot`, and `MemoqDebuggerWriteTextRequest` are introduced before use.
  - `MemoqAdapter.fillSegment` accepts the new context and `content-script.ts` passes it.
