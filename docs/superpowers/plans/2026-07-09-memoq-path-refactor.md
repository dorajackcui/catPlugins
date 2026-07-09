# memoQ Path Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the memoQ path so legacy and modern memoQ editors are isolated behind DOM profiles, with scanning, text handling, trusted writing, and fill transactions split into focused modules.

**Architecture:** Keep `MemoqAdapter` as the public facade used by `content-script.ts`. Move memoQ text serialization to `memoq-text.ts`, editor-specific selectors to `memoq-dom-profile.ts`, row scanning to `memoq-row-reader.ts`, and write/confirmation logic to `memoq-fill-transaction.ts`. Add a shared trusted text writer helper that uses the existing background debugger write request.

**Tech Stack:** TypeScript Chrome extension, Chrome runtime messaging, Chrome debugger `Input.insertText`, Node test runner with `--experimental-transform-types`, existing `ContentScriptDomHelpers`.

---

## Scope Check

This plan covers only the memoQ path. It intentionally avoids internal rewrites of Phrase, GientTrans, Excel parsing, matching, popup rendering, and storage.

## File Structure

- Create `memoq-text.ts`
  - Pure memoQ text helpers: inline tag formatting, accessibility-to-rendered conversion, whitespace marker normalization, commit-text comparison, DOM serialization.
- Create `trusted-text-writer.ts`
  - Measures a visible target element and sends `MEMOQ_DEBUGGER_WRITE_TEXT` or `DEBUGGER_WRITE_TEXT` to the background.
- Create `memoq-dom-profile.ts`
  - Defines `MemoqDomProfile`.
  - Exports `legacyWebtransMemoqProfile`, `modernEditorMemoqProfile`, and `selectMemoqDomProfile`.
- Create `memoq-row-reader.ts`
  - Scans visible memoQ rows through a profile.
  - Re-resolves current rows and collects nearby diagnostics.
- Create `memoq-fill-transaction.ts`
  - Executes one verified fill transaction through a profile, row reader, and trusted writer.
- Modify `memoq-adapter.ts`
  - Shrink to facade methods used by `content-script.ts`.
  - Re-export memoQ text helpers temporarily so existing tests can move gradually.
- Modify `editor-url.ts`
  - Recognize legacy and modern memoQ URLs.
- Modify `types.ts`
  - Add `profileId` to memoQ diagnostics.
  - Remove memoQ click-only request types after transaction code uses trusted text write.
- Modify `background.ts`
  - Keep `MEMOQ_DEBUGGER_PREPARE` for pre-run attachment.
  - Keep `MEMOQ_DEBUGGER_WRITE_TEXT` for click plus `Input.insertText`.
  - Remove `MEMOQ_DEBUGGER_CLICK` once no content script sends it.
- Modify tests:
  - `tests/memoq-test-dom.ts`
  - `tests/memoq-text.test.ts`
  - `tests/trusted-text-writer.test.ts`
  - `tests/memoq-dom-profile.test.ts`
  - `tests/memoq-row-reader.test.ts`
  - `tests/memoq-fill-transaction.test.ts`
  - Existing `tests/memoq-accessibility.test.ts`
  - Existing `tests/editor-url.test.ts`
  - Existing `tests/scan-dedupe.test.ts`

## Commit Strategy

Commit after each task. Stage only files listed in that task.

Before starting implementation, run:

```powershell
git status --short
```

Expected: no tracked file changes except work intentionally produced by the current task.

---

### Task 1: Extract Pure memoQ Text Helpers

**Files:**
- Create: `memoq-text.ts`
- Create: `tests/memoq-test-dom.ts`
- Modify: `memoq-adapter.ts`
- Create: `tests/memoq-text.test.ts`
- Modify: `tests/memoq-accessibility.test.ts`

- [ ] **Step 1: Create a small memoQ fake DOM test helper**

Create `tests/memoq-test-dom.ts`:

```ts
export interface FakeRect {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface FakeElementOptions {
  tagName?: string;
  id?: string;
  className?: string;
  textContent?: string;
  attributes?: Record<string, string>;
  rect?: FakeRect;
  children?: Array<FakeElement | FakeTextNode>;
}

export interface FakeTextNode {
  nodeType: 3;
  textContent: string;
  parentElement?: FakeElement;
}

export interface FakeElement {
  nodeType: 1;
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  innerText: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  childNodes: Array<FakeElement | FakeTextNode>;
  classList: { contains(className: string): boolean };
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  querySelector<T extends Element = Element>(selector: string): T | null;
  querySelectorAll<T extends Element = Element>(selector: string): T[];
  getBoundingClientRect(): DOMRect;
  scrollIntoView(): void;
}

export function fakeText(textContent: string): FakeTextNode {
  return {
    nodeType: 3,
    textContent
  };
}

export function fakeElement(options: FakeElementOptions = {}): FakeElement {
  const element: FakeElement = {
    nodeType: 1,
    tagName: options.tagName ?? 'DIV',
    id: options.id ?? '',
    className: options.className ?? '',
    textContent: options.textContent ?? '',
    innerText: options.textContent ?? '',
    parentElement: null,
    children: [],
    childNodes: [],
    classList: {
      contains: (className: string) =>
        (options.className ?? '').split(/\s+/).includes(className)
    },
    attributes: options.attributes ?? {},
    getAttribute: (name: string) => element.attributes[name] ?? null,
    matches: (selector: string) => matchesSelector(element, selector),
    querySelector: <T extends Element = Element>(selector: string): T | null => {
      const first = querySelectorAll(element, selector)[0];
      return (first as unknown as T | undefined) ?? null;
    },
    querySelectorAll: <T extends Element = Element>(selector: string): T[] =>
      querySelectorAll(element, selector) as unknown as T[],
    getBoundingClientRect: () => {
      const width = options.rect?.width ?? 120;
      const height = options.rect?.height ?? 24;
      const left = options.rect?.left ?? 0;
      const top = options.rect?.top ?? 0;
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height
      } as DOMRect;
    },
    scrollIntoView: () => undefined
  };

  for (const child of options.children ?? []) {
    appendChild(element, child);
  }

  if (element.children.length === 0 && element.textContent) {
    const textNode = fakeText(element.textContent);
    textNode.parentElement = element;
    element.childNodes.push(textNode);
  }

  return element;
}

export function appendChild(parent: FakeElement, child: FakeElement | FakeTextNode): void {
  child.parentElement = parent;
  parent.childNodes.push(child);
  if (child.nodeType === 1) {
    parent.children.push(child);
  }
}

export function fakeDocument(root: FakeElement): Document {
  return {
    body: root,
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector)
  } as unknown as Document;
}

function querySelectorAll(root: FakeElement, selector: string): FakeElement[] {
  const matches: FakeElement[] = [];

  const visit = (element: FakeElement): void => {
    if (element.matches(selector)) {
      matches.push(element);
    }

    for (const child of element.children) {
      visit(child);
    }
  };

  visit(root);
  return matches;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  if (selector === '*') {
    return true;
  }

  if (selector === 'textarea' || selector === 'input') {
    return element.tagName.toLowerCase() === selector;
  }

  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && element.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) {
    return false;
  }

  for (const classMatch of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!element.className.split(/\s+/).includes(classMatch[1])) {
      return false;
    }
  }

  for (const attrMatch of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
    const attrName = attrMatch[1];
    const expected = attrMatch[2];
    const actual = element.getAttribute(attrName);
    if (actual === null) {
      return false;
    }
    if (expected !== undefined && actual !== expected) {
      return false;
    }
  }

  return true;
}
```

- [ ] **Step 2: Create the focused text test**

Create `tests/memoq-text.test.ts` with the pure tests currently living in `tests/memoq-accessibility.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from '../memoq-text.ts';
import { fakeElement, fakeText } from './memoq-test-dom.ts';

const NBSP = String.fromCharCode(0x00a0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const MIDDLE_DOT = String.fromCharCode(0x00b7);
const DEGREE = String.fromCharCode(0x00b0);

test('formatMemoqInlineTag converts memoQ tag DOM classes to placeholder markup', () => {
  assert.equal(formatMemoqInlineTag('tag inline-empty editor-char', '1'), '<1>');
  assert.equal(formatMemoqInlineTag('tag inline-open editor-char', '2'), '{2>');
  assert.equal(formatMemoqInlineTag('tag inline-close editor-char', '2'), '<2}');
});

test('memoQ accessibility text can be compared with rendered cell text', () => {
  const target = 'Objectif de points atteint<1>Recuperer des recompenses';

  assert.equal(
    memoQAccessibilityTextToRenderedText(target),
    'Objectif de points atteint1Recuperer des recompenses'
  );
  assert.equal(
    isMemoqCommittedTargetText(
      'Objectif de points atteint1Recuperer des recompenses',
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

test('isMemoqCommittedTargetText accepts memoQ whitespace display marks', () => {
  assert.equal(
    isMemoqCommittedTargetText(
      `Il${MIDDLE_DOT}y${MIDDLE_DOT}a${MIDDLE_DOT}un`,
      'Il y a un'
    ),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      `Tu${MIDDLE_DOT}as${MIDDLE_DOT}${DEGREE}?`,
      `Tu as${NBSP}?`
    ),
    true
  );
  assert.equal(
    isMemoqCommittedTargetText(
      `Objectif${MIDDLE_DOT}atteint1Recuperer`,
      'Objectif atteint<1>Recuperer'
    ),
    true
  );
  assert.equal(isMemoqCommittedTargetText('Bonsoir le monde', 'Bonjour le monde'), false);
});

test('isMemoqCommittedTargetText treats rendered no-break spaces and plain spaces as equal', () => {
  assert.equal(isMemoqCommittedTargetText(`Bonjour${NBSP}!`, `Bonjour${NBSP}!`), true);
  assert.equal(isMemoqCommittedTargetText('Bonjour !', `Bonjour${NBSP}!`), true);
  assert.equal(
    isMemoqCommittedTargetText(`Bonjour${NBSP}le monde${NARROW_NBSP}!`, 'Bonjour le monde !'),
    true
  );
});

test('serializeMemoqContent converts inline tag elements while ignoring input elements', () => {
  const root = fakeElement({
    children: [
      fakeText('A'),
      fakeElement({
        className: 'tag inline-open editor-char',
        children: [fakeElement({ className: 'tag-content', textContent: '1' })]
      }),
      fakeText('B'),
      fakeElement({ tagName: 'INPUT', attributes: { value: 'ignored' } }),
      fakeElement({
        className: 'tag inline-close editor-char',
        children: [fakeElement({ className: 'tag-content', textContent: '1' })]
      }),
      fakeText('C')
    ]
  });

  assert.equal(serializeMemoqContent(root as unknown as HTMLElement), 'A{1>}B<1}C');
});
```

- [ ] **Step 3: Run the new test and verify it fails**

Run:

```powershell
npm test -- tests/memoq-text.test.ts
```

Expected: FAIL because `../memoq-text.ts` does not exist.

- [ ] **Step 4: Create `memoq-text.ts`**

Move the pure helpers out of `memoq-adapter.ts` and expose this API:

```ts
import { normalizeText } from './utils.ts';

const MEMOQ_RENDERED_WHITESPACE_MARKS = new RegExp(
  `[${String.fromCharCode(0x00b7, 0x00b0)}]`,
  'g'
);

export function stripMemoqInlineTagMarkup(value: string): string {
  return value
    .replace(/\{(\d+)>/g, '$1')
    .replace(/<(\d+)\}/g, '$1')
    .replace(/<(\d+)>/g, '$1');
}

export function memoQAccessibilityTextToRenderedText(value: string): string {
  return normalizeText(stripMemoqInlineTagMarkup(value));
}

function normalizeMemoqRenderedWhitespace(value: string): string {
  return normalizeText(value.replace(MEMOQ_RENDERED_WHITESPACE_MARKS, ' '));
}

export function isMemoqCommittedTargetText(cellText: string, value: string): boolean {
  const committedText = normalizeText(cellText);
  const expected = normalizeText(value);
  const renderedExpected = memoQAccessibilityTextToRenderedText(value);

  if (committedText === expected || committedText === renderedExpected) {
    return true;
  }

  const committedMarked = normalizeMemoqRenderedWhitespace(cellText);
  return (
    committedMarked === normalizeMemoqRenderedWhitespace(value) ||
    committedMarked === normalizeMemoqRenderedWhitespace(stripMemoqInlineTagMarkup(value))
  );
}

export function formatMemoqInlineTag(className: string, tagText: string): string {
  const tagId = normalizeText(tagText);
  if (!tagId) {
    return '';
  }

  if (className.includes('inline-open')) {
    return `{${tagId}>`;
  }

  if (className.includes('inline-close')) {
    return `<${tagId}}`;
  }

  return `<${tagId}>`;
}

export function serializeMemoqContent(content: HTMLElement): string {
  const fragments: string[] = [];

  const visit = (node: ChildNode): void => {
    if (node.nodeType === 3) {
      fragments.push(node.textContent || '');
      return;
    }

    if (node.nodeType !== 1) {
      return;
    }

    const element = node as HTMLElement;
    if (element.matches('textarea,input')) {
      return;
    }

    if (element.classList.contains('tag')) {
      const tagContent = element.querySelector<HTMLElement>('.tag-content');
      fragments.push(formatMemoqInlineTag(element.className, tagContent?.textContent || element.textContent || ''));
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      visit(child);
    }
  };

  for (const child of Array.from(content.childNodes)) {
    visit(child);
  }

  const serialized = fragments.join('');
  return normalizeText(serialized || content.innerText || content.textContent || '');
}
```

- [ ] **Step 5: Re-export text helpers from `memoq-adapter.ts`**

Add this export near the top of `memoq-adapter.ts` so existing imports keep working during the migration:

```ts
export {
  formatMemoqInlineTag,
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from './memoq-text.ts';
```

Then import the helpers used internally:

```ts
import {
  isMemoqCommittedTargetText,
  memoQAccessibilityTextToRenderedText,
  serializeMemoqContent
} from './memoq-text.ts';
```

Remove the old local definitions of `stripMemoqInlineTagMarkup`, `memoQAccessibilityTextToRenderedText`, `MEMOQ_RENDERED_WHITESPACE_MARKS`, `normalizeMemoqRenderedWhitespace`, `isMemoqCommittedTargetText`, `formatMemoqInlineTag`, and the private `serializeMemoqContent` method. In `getEditableValue`, call:

```ts
return serializeMemoqContent(content);
```

- [ ] **Step 6: Update tests that only need pure helpers**

In `tests/memoq-accessibility.test.ts`, remove the pure text tests copied into `tests/memoq-text.test.ts`. Keep fill and adapter tests there. Change the import block so pure helpers come from `../memoq-text.ts` only if the remaining tests still use them:

```ts
import {
  isMemoqCommittedTargetText
} from '../memoq-text.ts';
```

- [ ] **Step 7: Verify text tests and full suite**

Run:

```powershell
npm test -- tests/memoq-text.test.ts
npm test -- tests/memoq-accessibility.test.ts
npm run typecheck
```

Expected: PASS for both test commands and typecheck.

- [ ] **Step 8: Commit**

```powershell
git add memoq-text.ts memoq-adapter.ts tests/memoq-test-dom.ts tests/memoq-text.test.ts tests/memoq-accessibility.test.ts
git commit -m "Extract memoQ text helpers"
```

---

### Task 2: Add Shared Trusted Text Writer

**Files:**
- Create: `trusted-text-writer.ts`
- Create: `tests/trusted-text-writer.test.ts`
- Modify: `types.ts`

- [ ] **Step 1: Write the trusted writer tests**

Create `tests/trusted-text-writer.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { writeTrustedTextToElement } from '../trusted-text-writer.ts';

function installChromeRecorder(messages: unknown[], response: unknown = { ok: true, data: null }): () => void {
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
    await writeTrustedTextToElement(target, 'Bonjour', { requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT' });
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

  await assert.rejects(
    () => writeTrustedTextToElement(target, 'Bonjour', { requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT' }),
    /target element is not visible enough to write/
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
    await assert.rejects(
      () => writeTrustedTextToElement(target, 'Bonjour', { requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT' }),
      /debugger failed/
    );
  } finally {
    restoreChrome();
  }
});
```

- [ ] **Step 2: Run the trusted writer test and verify it fails**

Run:

```powershell
npm test -- tests/trusted-text-writer.test.ts
```

Expected: FAIL because `../trusted-text-writer.ts` does not exist.

- [ ] **Step 3: Create `trusted-text-writer.ts`**

```ts
import { runtimeSendMessage } from './chrome-api.ts';
import type { ApiResponse, BackgroundRequest } from './types.ts';

export type TrustedTextWriteRequestType =
  | 'MEMOQ_DEBUGGER_WRITE_TEXT'
  | 'DEBUGGER_WRITE_TEXT';

export interface TrustedTextWriteOptions {
  requestType: TrustedTextWriteRequestType;
  settleMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function writeTrustedTextToElement(
  targetElement: HTMLElement,
  text: string,
  options: TrustedTextWriteOptions
): Promise<void> {
  targetElement.scrollIntoView?.({ block: 'center', inline: 'nearest' });

  if (options.settleMs && options.settleMs > 0) {
    await delay(options.settleMs);
  }

  const rect = targetElement.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Trusted text target element is not visible enough to write.');
  }

  const response = await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
    type: options.requestType,
    payload: {
      x,
      y,
      text
    }
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
}
```

- [ ] **Step 4: Verify type union still accepts both write request types**

In `types.ts`, keep both request interfaces:

```ts
export interface MemoqDebuggerWriteTextRequest {
  type: 'MEMOQ_DEBUGGER_WRITE_TEXT';
  payload: {
    x: number;
    y: number;
    text: string;
  };
}

export interface DebuggerWriteTextRequest {
  type: 'DEBUGGER_WRITE_TEXT';
  payload: {
    x: number;
    y: number;
    text: string;
  };
}
```

Do not remove `MEMOQ_DEBUGGER_CLICK` in this task.

- [ ] **Step 5: Verify trusted writer**

Run:

```powershell
npm test -- tests/trusted-text-writer.test.ts
npm run typecheck
```

Expected: PASS for the test and typecheck.

- [ ] **Step 6: Commit**

```powershell
git add trusted-text-writer.ts tests/trusted-text-writer.test.ts types.ts
git commit -m "Add trusted text writer helper"
```

---

### Task 3: Add memoQ DOM Profiles

**Files:**
- Create: `memoq-dom-profile.ts`
- Create: `tests/memoq-dom-profile.test.ts`
- Modify: `editor-url.ts`
- Modify: `tests/editor-url.test.ts`

- [ ] **Step 1: Write URL tests for modern memoQ**

Append this test to `tests/editor-url.test.ts`:

```ts
test('modern memoQ editor document URLs are supported', () => {
  const url =
    'https://memoq.diezhi.net/memoqweb/editor/projects/482f20b9-a616-f011-94f4-005056bb3114/docs/8e20350e-2671-4ac8-a58d-cd8de932c678';

  assert.equal(isMemoqUrl(url), true);
  assert.equal(isSupportedEditorUrl(url), true);
});
```

- [ ] **Step 2: Run URL tests and verify the new case fails**

Run:

```powershell
npm test -- tests/editor-url.test.ts
```

Expected: FAIL on `modern memoQ editor document URLs are supported`.

- [ ] **Step 3: Update memoQ URL detection**

Replace the memoQ URL constants in `editor-url.ts` with:

```ts
const MEMOQ_LEGACY_WEBTRANS_URL_RE =
  /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/(?:webpm\/)?webtrans\//;
const MEMOQ_MODERN_EDITOR_URL_RE =
  /^https:\/\/memoq\.[^/]+\.net\/memoqweb\/editor\/projects\/[^/]+\/docs\/[^/?#]+(?:[/?#]|$)/;
```

Then update `isSupportedEditorUrl` and `isMemoqUrl`:

```ts
function isMemoqEditorUrl(url: string): boolean {
  return MEMOQ_LEGACY_WEBTRANS_URL_RE.test(url) || MEMOQ_MODERN_EDITOR_URL_RE.test(url);
}

export function isSupportedEditorUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('https://app.phrase.com/editor/') ||
    MEMSOURCE_JOB_URL_RE.test(url) ||
    isMemoqEditorUrl(url) ||
    GIENTRANS_EDITOR_URL_RE.test(url)
  );
}

export function isMemoqUrl(url?: string): boolean {
  return Boolean(url && isMemoqEditorUrl(url));
}
```

- [ ] **Step 4: Write DOM profile tests**

Create `tests/memoq-dom-profile.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  legacyWebtransMemoqProfile,
  modernEditorMemoqProfile,
  selectMemoqDomProfile
} from '../memoq-dom-profile.ts';
import { fakeDocument, fakeElement, type FakeElement } from './memoq-test-dom.ts';

function withDocument(root: FakeElement, run: () => void): void {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument(root);

  try {
    run();
  } finally {
    globalThis.document = previousDocument;
  }
}

function legacyRoot(): FakeElement {
  return fakeElement({
    children: [
      fakeElement({
        className: 'row',
        children: [
          fakeElement({ textContent: '15' }),
          fakeElement({ className: 'editor-cell', textContent: 'Source' }),
          fakeElement({ className: 'editor-cell', textContent: '' })
        ]
      })
    ]
  });
}

function modernRoot(source = 'Source', target = '', rowNumber = '1123'): FakeElement {
  return fakeElement({
    children: [
      fakeElement({
        attributes: { role: 'table', 'aria-label': 'translation area' },
        children: [
          fakeElement({
            attributes: { role: 'row' },
            children: [
              fakeElement({
                className: 'ProseMirror',
                textContent: source,
                attributes: {
                  contenteditable: 'true',
                  role: 'gridcell',
                  'aria-label': `row ${rowNumber} source segment`
                }
              }),
              fakeElement({
                className: 'ProseMirror',
                textContent: target,
                attributes: {
                  contenteditable: 'true',
                  role: 'gridcell',
                  'aria-label': `row ${rowNumber} target segment`
                }
              })
            ]
          })
        ]
      })
    ]
  });
}

test('legacy profile detects editor-cell memoQ rows', () => {
  withDocument(legacyRoot(), () => {
    assert.equal(legacyWebtransMemoqProfile.matches(document), true);
    assert.equal(selectMemoqDomProfile(document)?.id, 'legacy-webtrans');
  });
});

test('modern profile detects ProseMirror translation rows', () => {
  withDocument(modernRoot(), () => {
    assert.equal(modernEditorMemoqProfile.matches(document), true);
    assert.equal(selectMemoqDomProfile(document)?.id, 'modern-editor');
  });
});

test('modern profile reads row number and source target cells from accessible labels', () => {
  withDocument(modernRoot('Source text', 'Target text'), () => {
    const row = modernEditorMemoqProfile.findVisibleRows(document)[0];
    const cells = modernEditorMemoqProfile.findCells(row);

    assert.equal(modernEditorMemoqProfile.readRowNumber(row), '1123');
    assert.equal(cells?.source.textContent, 'Source text');
    assert.equal(cells?.target.textContent, 'Target text');
  });
});

test('modern profile ignores read-only ProseMirror panes outside translation rows', () => {
  const root = fakeElement({
    children: [
      fakeElement({
        className: 'ProseMirror',
        textContent: 'TM source',
        attributes: { contenteditable: 'false' }
      }),
      ...modernRoot().children
    ]
  });

  withDocument(root, () => {
    assert.equal(modernEditorMemoqProfile.findVisibleRows(document).length, 1);
  });
});
```

- [ ] **Step 5: Run DOM profile tests and verify they fail**

Run:

```powershell
npm test -- tests/memoq-dom-profile.test.ts
```

Expected: FAIL because `../memoq-dom-profile.ts` does not exist.

- [ ] **Step 6: Create `memoq-dom-profile.ts`**

```ts
import type { ScrollContext } from './content-script-dom.ts';

export interface MemoqProfileCells {
  source: HTMLElement;
  target: HTMLElement;
}

export interface MemoqDomProfile {
  id: 'legacy-webtrans' | 'modern-editor';
  matches(root: ParentNode): boolean;
  findVisibleRows(root: ParentNode): HTMLElement[];
  findCells(row: HTMLElement): MemoqProfileCells | null;
  readRowNumber(row: HTMLElement): string | undefined;
  findScrollRoot(root: ParentNode): HTMLElement | null;
  findCurrentTargetByRowNumber(root: ParentNode, rowNumber: string): HTMLElement | null;
  getContentRoot(cell: HTMLElement): HTMLElement;
  getWriteTarget(targetCell: HTMLElement): HTMLElement;
  createSyntheticScrollTarget(root: ParentNode): HTMLElement | null;
}

const LEGACY_CELL_SELECTOR = '.editor-cell';
const LEGACY_CONTENT_SELECTOR = '.content-container';
const MODERN_TABLE_SELECTOR = '[role="table"]';
const MODERN_CELL_SELECTOR = '.ProseMirror[contenteditable="true"][role="gridcell"]';
const MODERN_ROW_NUMBER_RE = /(?:row|line)\s+(\d+)|(\d+)/i;
const MODERN_SOURCE_RE = /source/i;
const MODERN_TARGET_RE = /target/i;

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect?.() ?? { width: 1, height: 1 };
  return rect.width > 0 && rect.height > 0;
}

function findLegacyRowContainer(cell: HTMLElement): HTMLElement | null {
  let cursor: HTMLElement | null = cell.parentElement;

  while (cursor && cursor !== document.body) {
    if (cursor.querySelectorAll(LEGACY_CELL_SELECTOR).length >= 2) {
      return cursor;
    }
    cursor = cursor.parentElement;
  }

  return null;
}

function readModernLabel(element: HTMLElement): string {
  return element.getAttribute('aria-label') || '';
}

function readModernRowNumberFromLabel(label: string): string | undefined {
  const match = label.match(MODERN_ROW_NUMBER_RE);
  return match?.[1] ?? match?.[2];
}

export const legacyWebtransMemoqProfile: MemoqDomProfile = {
  id: 'legacy-webtrans',
  matches: (root) => root.querySelector(LEGACY_CELL_SELECTOR) !== null,
  findVisibleRows: (root) => {
    const rows = new Set<HTMLElement>();
    for (const cell of Array.from(root.querySelectorAll<HTMLElement>(LEGACY_CELL_SELECTOR))) {
      const row = findLegacyRowContainer(cell);
      if (row && isVisible(cell)) {
        rows.add(row);
      }
    }
    return [...rows];
  },
  findCells: (row) => {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(LEGACY_CELL_SELECTOR))
      .filter(isVisible)
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
    if (cells.length < 2) {
      return null;
    }
    return { source: cells[0], target: cells[cells.length - 1] };
  },
  readRowNumber: (row) => {
    for (const child of Array.from(row.children)) {
      const element = child as HTMLElement;
      if (element.matches(LEGACY_CELL_SELECTOR)) {
        continue;
      }
      const match = (element.innerText || element.textContent || '').trim().match(/^(\d+)\.?$/);
      if (match) {
        return match[1];
      }
    }
    const ariaRowIndex = row.getAttribute('aria-rowindex');
    return ariaRowIndex && /^\d+$/.test(ariaRowIndex) ? ariaRowIndex : undefined;
  },
  findScrollRoot: () => null,
  findCurrentTargetByRowNumber: (root, rowNumber) => {
    for (const row of legacyWebtransMemoqProfile.findVisibleRows(root)) {
      if (legacyWebtransMemoqProfile.readRowNumber(row) !== rowNumber) {
        continue;
      }
      return legacyWebtransMemoqProfile.findCells(row)?.target ?? null;
    }
    return null;
  },
  getContentRoot: (cell) => cell.querySelector<HTMLElement>(LEGACY_CONTENT_SELECTOR) || cell,
  getWriteTarget: (targetCell) => targetCell,
  createSyntheticScrollTarget: (root) => root.querySelector<HTMLElement>(LEGACY_CELL_SELECTOR)
};

export const modernEditorMemoqProfile: MemoqDomProfile = {
  id: 'modern-editor',
  matches: (root) => root.querySelector(MODERN_CELL_SELECTOR) !== null,
  findVisibleRows: (root) => {
    const tables = Array.from(root.querySelectorAll<HTMLElement>(MODERN_TABLE_SELECTOR));
    const rows: HTMLElement[] = [];
    for (const table of tables) {
      for (const row of Array.from(table.querySelectorAll<HTMLElement>('[role="row"]'))) {
        if (modernEditorMemoqProfile.findCells(row)) {
          rows.push(row);
        }
      }
    }
    return rows;
  },
  findCells: (row) => {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(MODERN_CELL_SELECTOR)).filter(isVisible);
    const source = cells.find((cell) => MODERN_SOURCE_RE.test(readModernLabel(cell)));
    const target = cells.find((cell) => MODERN_TARGET_RE.test(readModernLabel(cell)));
    return source && target ? { source, target } : null;
  },
  readRowNumber: (row) => {
    const cells = Array.from(row.querySelectorAll<HTMLElement>(MODERN_CELL_SELECTOR));
    for (const cell of cells) {
      const rowNumber = readModernRowNumberFromLabel(readModernLabel(cell));
      if (rowNumber) {
        return rowNumber;
      }
    }
    return undefined;
  },
  findScrollRoot: (root) => root.querySelector<HTMLElement>('[role="table"]'),
  findCurrentTargetByRowNumber: (root, rowNumber) => {
    for (const row of modernEditorMemoqProfile.findVisibleRows(root)) {
      if (modernEditorMemoqProfile.readRowNumber(row) !== rowNumber) {
        continue;
      }
      return modernEditorMemoqProfile.findCells(row)?.target ?? null;
    }
    return null;
  },
  getContentRoot: (cell) => cell,
  getWriteTarget: (targetCell) => targetCell,
  createSyntheticScrollTarget: (root) => root.querySelector<HTMLElement>(MODERN_TABLE_SELECTOR)
};

export function selectMemoqDomProfile(root: ParentNode = document): MemoqDomProfile | null {
  for (const profile of [modernEditorMemoqProfile, legacyWebtransMemoqProfile]) {
    if (profile.matches(root)) {
      return profile;
    }
  }
  return null;
}
```

- [ ] **Step 7: Verify URL and profile tests**

Run:

```powershell
npm test -- tests/editor-url.test.ts
npm test -- tests/memoq-dom-profile.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add editor-url.ts tests/editor-url.test.ts memoq-dom-profile.ts tests/memoq-dom-profile.test.ts
git commit -m "Add memoQ DOM profiles"
```

---

### Task 4: Introduce memoQ Row Reader

**Files:**
- Create: `memoq-row-reader.ts`
- Create: `tests/memoq-row-reader.test.ts`
- Modify: `memoq-adapter.ts`

- [ ] **Step 1: Write row reader tests**

Create `tests/memoq-row-reader.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers } from '../content-script-dom.ts';
import { modernEditorMemoqProfile } from '../memoq-dom-profile.ts';
import { MemoqRowReader } from '../memoq-row-reader.ts';
import { fakeDocument, fakeElement, type FakeElement } from './memoq-test-dom.ts';

function installWindow(): () => void {
  const previousWindow = globalThis.window;
  globalThis.window = {
    innerHeight: 800,
    scrollY: 0,
    scrollBy: () => undefined,
    scrollTo: () => undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'auto' })
  } as unknown as Window & typeof globalThis;
  return () => {
    globalThis.window = previousWindow;
  };
}

function installDocument(root: FakeElement): () => void {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument(root);
  return () => {
    globalThis.document = previousDocument;
  };
}

function modernRow(rowNumber: string, source: string, target: string, top: number): FakeElement {
  return fakeElement({
    attributes: { role: 'row' },
    rect: { top },
    children: [
      fakeElement({
        className: 'ProseMirror',
        textContent: source,
        rect: { left: 10, top },
        attributes: {
          contenteditable: 'true',
          role: 'gridcell',
          'aria-label': `row ${rowNumber} source segment`
        }
      }),
      fakeElement({
        id: `target-${rowNumber}`,
        className: 'ProseMirror',
        textContent: target,
        rect: { left: 200, top },
        attributes: {
          contenteditable: 'true',
          role: 'gridcell',
          'aria-label': `row ${rowNumber} target segment`
        }
      })
    ]
  });
}

function modernTable(rows: FakeElement[]): FakeElement {
  return fakeElement({
    attributes: { role: 'table' },
    children: rows
  });
}

test('MemoqRowReader reads modern visible segments', () => {
  const restoreWindow = installWindow();
  const restoreDocument = installDocument(
    modernTable([
      modernRow('1123', 'Source A', '', 10),
      modernRow('1124', 'Source B', 'Target B', 40)
    ])
  );

  try {
    const helpers = new ContentScriptDomHelpers();
    const reader = new MemoqRowReader(modernEditorMemoqProfile, helpers);
    const scrollContext = helpers.toWindowScrollContext();
    const segments = reader.collectVisibleSegments(scrollContext);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].rowNumber, '1123');
    assert.equal(segments[0].sourceRaw, 'Source A');
    assert.equal(segments[0].targetRaw, '');
    assert.equal(segments[0].isEmptyTarget, true);
    assert.equal(segments[1].rowNumber, '1124');
    assert.equal(segments[1].targetRaw, 'Target B');
  } finally {
    restoreDocument();
    restoreWindow();
  }
});

test('MemoqRowReader resolves current target by row number', () => {
  const restoreWindow = installWindow();
  const restoreDocument = installDocument(
    modernTable([modernRow('15', 'Source', '', 10)])
  );

  try {
    const reader = new MemoqRowReader(modernEditorMemoqProfile, new ContentScriptDomHelpers());
    assert.equal(reader.findCurrentTargetByRowNumber('15')?.id, 'target-15');
    assert.equal(
      reader.getCurrentSourceValue({
        domId: '15',
        rowNumber: '15',
        sourceRaw: 'Source',
        sourceNormalized: 'Source',
        occurrenceIndex: 0,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: reader.findCurrentTargetByRowNumber('15') as HTMLElement,
        platform: 'memoq'
      }),
      'Source'
    );
  } finally {
    restoreDocument();
    restoreWindow();
  }
});
```

- [ ] **Step 2: Run row reader tests and verify they fail**

Run:

```powershell
npm test -- tests/memoq-row-reader.test.ts
```

Expected: FAIL because `../memoq-row-reader.ts` does not exist.

- [ ] **Step 3: Create `memoq-row-reader.ts`**

```ts
import { extractPlaceholderTokens } from './qa.ts';
import type { RuntimeSegment, ScrollContext, ContentScriptDomHelpers } from './content-script-dom.ts';
import type { MemoqDomProfile } from './memoq-dom-profile.ts';
import { serializeMemoqContent } from './memoq-text.ts';
import { normalizeText } from './utils.ts';

const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;

export interface MemoqVisibleRowDiagnostic {
  rowNumber?: string;
  source: string;
  target: string;
}

export class MemoqRowReader {
  constructor(
    private readonly profile: MemoqDomProfile,
    private readonly helpers: ContentScriptDomHelpers
  ) {}

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      this.profile.findVisibleRows(document).filter((row) => this.helpers.isElementVisible(row)),
      scrollContext
    );
    const segments = rows
      .map((row) => this.extractSegment(row, scrollContext))
      .filter((segment): segment is RuntimeSegment => segment !== null);

    return this.dedupeVisibleSegments(segments, scrollContext);
  }

  findCurrentCellsByRowNumber(rowNumber?: string): { source: HTMLElement; target: HTMLElement } | null {
    if (!rowNumber) {
      return null;
    }

    for (const row of this.profile.findVisibleRows(document)) {
      if (this.profile.readRowNumber(row) !== rowNumber) {
        continue;
      }

      return this.profile.findCells(row);
    }

    return null;
  }

  findCurrentTargetByRowNumber(rowNumber?: string): HTMLElement | null {
    return this.findCurrentCellsByRowNumber(rowNumber)?.target ?? null;
  }

  getCurrentSourceValue(segment: RuntimeSegment): string {
    const source = this.findCurrentCellsByRowNumber(segment.rowNumber)?.source;
    return source ? this.getEditableValue(source) : '';
  }

  getEditableValue(targetElement: HTMLElement): string {
    const contentRoot = this.profile.getContentRoot(targetElement);
    return serializeMemoqContent(contentRoot);
  }

  collectVisibleRowDiagnostics(targetRowNumber?: string, radius = 2): MemoqVisibleRowDiagnostic[] {
    const diagnostics = this.profile.findVisibleRows(document).map((row) => {
      const cells = this.profile.findCells(row);
      return {
        rowNumber: this.profile.readRowNumber(row),
        source: cells ? this.getEditableValue(cells.source) : '',
        target: cells ? this.getEditableValue(cells.target) : ''
      };
    });

    if (!targetRowNumber) {
      return diagnostics.slice(-5);
    }

    const targetIndex = diagnostics.findIndex((row) => row.rowNumber === targetRowNumber);
    if (targetIndex === -1) {
      return diagnostics.slice(-5);
    }

    return diagnostics.slice(Math.max(0, targetIndex - radius), targetIndex + radius + 1);
  }

  private extractSegment(row: HTMLElement, scrollContext: ScrollContext): RuntimeSegment | null {
    const cells = this.profile.findCells(row);
    if (!cells) {
      return null;
    }

    const sourceRaw = this.getEditableValue(cells.source);
    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(cells.target);
    const rowNumber = this.profile.readRowNumber(row);
    const domId =
      rowNumber ||
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      rowNumber,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement: cells.target,
      platform: 'memoq',
      scanElement: row,
      scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
    };
  }

  private dedupeVisibleSegments(segments: RuntimeSegment[], scrollContext: ScrollContext): RuntimeSegment[] {
    const deduped = new Map<string, RuntimeSegment>();

    for (const segment of segments) {
      const topBucket = Math.round(
        this.helpers.getAbsoluteTop(segment.targetElement as Element, scrollContext) /
          VISIBLE_SEGMENT_TOP_BUCKET_PX
      );
      const visibleKey = `${segment.sourceNormalized}::${topBucket}`;
      const current = deduped.get(visibleKey);

      if (!current) {
        deduped.set(visibleKey, segment);
        continue;
      }

      const currentTarget = normalizeText(current.targetRaw);
      const nextTarget = normalizeText(segment.targetRaw);
      if (currentTarget.length === 0 && nextTarget.length > 0) {
        deduped.set(visibleKey, segment);
      }
    }

    return [...deduped.values()];
  }
}
```

- [ ] **Step 4: Delegate memoQ scanning from `memoq-adapter.ts`**

In `memoq-adapter.ts`, add imports:

```ts
import { selectMemoqDomProfile, type MemoqDomProfile } from './memoq-dom-profile.ts';
import { MemoqRowReader } from './memoq-row-reader.ts';
```

Add helper methods inside `MemoqAdapter`:

```ts
private getProfile(): MemoqDomProfile | null {
  return selectMemoqDomProfile(document);
}

private getRowReader(): MemoqRowReader | null {
  const profile = this.getProfile();
  return profile ? new MemoqRowReader(profile, this.helpers) : null;
}
```

Change `isActive`:

```ts
isActive(): boolean {
  return this.getProfile() !== null;
}
```

Change `collectVisibleSegments`:

```ts
collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
  return this.getRowReader()?.collectVisibleSegments(scrollContext) ?? [];
}
```

Change `getCurrentEditableValue`:

```ts
getCurrentEditableValue(segment: RuntimeSegment): string {
  const reader = this.getRowReader();
  const currentTargetCell = reader?.findCurrentTargetByRowNumber(segment.rowNumber);
  return this.getEditableValue((currentTargetCell ?? segment.targetElement) as HTMLElement);
}
```

Keep old private methods in the file until Task 6 removes unused code. TypeScript will identify unused private methods only if no references remain; leaving them temporarily is acceptable in this task.

- [ ] **Step 5: Verify row reader and existing memoQ tests**

Run:

```powershell
npm test -- tests/memoq-row-reader.test.ts
npm test -- tests/memoq-accessibility.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add memoq-row-reader.ts tests/memoq-row-reader.test.ts memoq-adapter.ts
git commit -m "Add memoQ row reader"
```

---

### Task 5: Introduce Verified memoQ Fill Transaction

**Files:**
- Create: `memoq-fill-transaction.ts`
- Create: `tests/memoq-fill-transaction.test.ts`
- Modify: `memoq-adapter.ts`
- Modify: `types.ts`

- [ ] **Step 1: Add profile id to diagnostics**

In `types.ts`, extend `MemoqFillDiagnosticBase`:

```ts
export interface MemoqFillDiagnosticBase {
  runId: string;
  sequence: number;
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
  profileId?: 'legacy-webtrans' | 'modern-editor';
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
```

- [ ] **Step 2: Write transaction tests**

Create `tests/memoq-fill-transaction.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content-script-dom.ts';
import type { MemoqDomProfile } from '../memoq-dom-profile.ts';
import { MemoqFillTransaction } from '../memoq-fill-transaction.ts';

function makeTarget(text = ''): HTMLElement {
  return {
    innerText: text,
    textContent: text,
    scrollIntoView: () => undefined,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 40
    })
  } as unknown as HTMLElement;
}

function makeSegment(targetElement: HTMLElement): RuntimeSegment {
  return {
    domId: '1123',
    rowNumber: '1123',
    sourceRaw: 'Source text',
    sourceNormalized: 'Source text',
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement,
    platform: 'memoq'
  };
}

function makeProfile(target: HTMLElement | null): MemoqDomProfile {
  return {
    id: 'modern-editor',
    matches: () => true,
    findVisibleRows: () => [],
    findCells: () => null,
    readRowNumber: () => undefined,
    findScrollRoot: () => null,
    findCurrentTargetByRowNumber: () => target,
    getContentRoot: (cell) => cell,
    getWriteTarget: (targetCell) => targetCell,
    createSyntheticScrollTarget: () => null
  };
}

test('MemoqFillTransaction refuses to write when current row target is missing', async () => {
  const target = makeTarget('');
  const transaction = new MemoqFillTransaction({
    profile: makeProfile(null),
    readTargetText: () => '',
    readSourceText: () => 'Source text',
    collectNearbyRows: () => [],
    writeTrustedText: async () => {
      throw new Error('write should not run');
    }
  });

  const outcome = await transaction.fillSegment(makeSegment(target), 'Bonjour');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'ROW_NOT_FOUND');
});

test('MemoqFillTransaction refuses to write when source changed', async () => {
  const target = makeTarget('');
  const transaction = new MemoqFillTransaction({
    profile: makeProfile(target),
    readTargetText: () => '',
    readSourceText: () => 'Different source',
    collectNearbyRows: () => [],
    writeTrustedText: async () => {
      throw new Error('write should not run');
    }
  });

  const outcome = await transaction.fillSegment(makeSegment(target), 'Bonjour');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'SOURCE_MISMATCH');
});

test('MemoqFillTransaction refuses to write when target is no longer empty', async () => {
  const target = makeTarget('Existing');
  const transaction = new MemoqFillTransaction({
    profile: makeProfile(target),
    readTargetText: () => 'Existing',
    readSourceText: () => 'Source text',
    collectNearbyRows: () => [],
    writeTrustedText: async () => {
      throw new Error('write should not run');
    }
  });

  const outcome = await transaction.fillSegment(makeSegment(target), 'Bonjour');

  assert.equal(outcome.filled, false);
  assert.equal(outcome.diagnostic?.failureCode, 'TARGET_NOT_EMPTY');
});

test('MemoqFillTransaction writes once and confirms same-row target text', async () => {
  const target = makeTarget('');
  let writes = 0;
  const transaction = new MemoqFillTransaction({
    profile: makeProfile(target),
    readTargetText: () => target.textContent || '',
    readSourceText: () => 'Source text',
    collectNearbyRows: () => [],
    writeTrustedText: async (_target, value) => {
      writes += 1;
      target.textContent = value;
      target.innerText = value;
    }
  });

  const outcome = await transaction.fillSegment(makeSegment(target), 'Bonjour');

  assert.equal(outcome.filled, true);
  assert.equal(writes, 1);
  assert.equal(outcome.diagnostic?.outcome, 'success');
});
```

- [ ] **Step 3: Run transaction tests and verify they fail**

Run:

```powershell
npm test -- tests/memoq-fill-transaction.test.ts
```

Expected: FAIL because `../memoq-fill-transaction.ts` does not exist.

- [ ] **Step 4: Create `memoq-fill-transaction.ts`**

```ts
import type { FillOutcome, MemoqFillFailureCode, MemoqFillDiagnostic, MemoqVisibleRowSnapshot } from './types.ts';
import type { RuntimeSegment } from './content-script-dom.ts';
import type { MemoqDomProfile } from './memoq-dom-profile.ts';
import { isMemoqCommittedTargetText } from './memoq-text.ts';
import { normalizeText } from './utils.ts';

const CONFIRM_ATTEMPTS = 14;
const CONFIRM_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export interface MemoqFillTransactionOptions {
  profile: MemoqDomProfile;
  readTargetText(target: HTMLElement): string;
  readSourceText(segment: RuntimeSegment): string;
  collectNearbyRows(rowNumber?: string): MemoqVisibleRowSnapshot[];
  writeTrustedText(target: HTMLElement, value: string): Promise<void>;
  runId?: string;
  sequence?: number;
  scanPass?: number;
  scrollTop?: number;
  scrollMode?: 'native' | 'synthetic';
}

export class MemoqFillTransaction {
  constructor(private readonly options: MemoqFillTransactionOptions) {}

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const target = this.options.profile.findCurrentTargetByRowNumber(document, segment.rowNumber ?? '');
    if (!target) {
      return this.failure(segment, value, 'ROW_NOT_FOUND', '', '', false);
    }

    const sourceBefore = this.options.readSourceText(segment);
    if (normalizeText(sourceBefore) !== normalizeText(segment.sourceRaw)) {
      return this.failure(segment, value, 'SOURCE_MISMATCH', sourceBefore, this.options.readTargetText(target), false);
    }

    const targetBefore = this.options.readTargetText(target);
    if (normalizeText(targetBefore) !== '') {
      return this.failure(segment, value, 'TARGET_NOT_EMPTY', sourceBefore, targetBefore, false);
    }

    const writeTarget = this.options.profile.getWriteTarget(target);
    try {
      await this.options.writeTrustedText(writeTarget, value);
    } catch {
      return this.failure(segment, value, 'INPUT_FAILED', sourceBefore, targetBefore, true);
    }

    const confirmation = await this.waitForConfirmation(target, value);
    if (!confirmation.ok) {
      return this.failure(segment, value, 'CONFIRM_TIMEOUT', sourceBefore, targetBefore, true, confirmation.targetAfter);
    }

    return {
      domId: segment.domId,
      filled: true,
      diagnostic: this.createDiagnostic({
        segment,
        value,
        outcome: 'success',
        sourceBefore,
        targetBefore,
        targetAfter: confirmation.targetAfter,
        activationAttempted: true,
        activationOk: true,
        confirmationOk: true
      })
    };
  }

  private async waitForConfirmation(target: HTMLElement, value: string): Promise<{ ok: boolean; targetAfter: string }> {
    let targetAfter = '';

    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      targetAfter = this.options.readTargetText(target);
      if (isMemoqCommittedTargetText(targetAfter, value)) {
        return { ok: true, targetAfter };
      }

      if (attempt < CONFIRM_ATTEMPTS - 1) {
        await delay(CONFIRM_DELAY_MS);
      }
    }

    return { ok: false, targetAfter };
  }

  private failure(
    segment: RuntimeSegment,
    value: string,
    failureCode: MemoqFillFailureCode,
    sourceBefore: string,
    targetBefore: string,
    activationAttempted: boolean,
    targetAfter = ''
  ): FillOutcome {
    return {
      domId: segment.domId,
      filled: false,
      diagnostic: this.createDiagnostic({
        segment,
        value,
        outcome: 'failure',
        failureCode,
        sourceBefore,
        targetBefore,
        targetAfter,
        activationAttempted,
        activationOk: failureCode !== 'INPUT_FAILED' && activationAttempted,
        confirmationOk: false
      })
    };
  }

  private createDiagnostic(input: {
    segment: RuntimeSegment;
    value: string;
    outcome: 'success' | 'failure';
    failureCode?: MemoqFillFailureCode;
    sourceBefore: string;
    targetBefore: string;
    targetAfter: string;
    activationAttempted: boolean;
    activationOk: boolean;
    confirmationOk: boolean;
  }): MemoqFillDiagnostic {
    return {
      outcome: input.outcome,
      failureCode: input.failureCode,
      runId: this.options.runId ?? 'memoq-fill',
      sequence: this.options.sequence ?? 0,
      scanPass: this.options.scanPass ?? 0,
      scrollTop: this.options.scrollTop ?? 0,
      scrollMode: this.options.scrollMode ?? 'native',
      profileId: this.options.profile.id,
      domId: input.segment.domId,
      rowNumber: input.segment.rowNumber,
      locatingMethod: input.segment.rowNumber ? 'rowNumber' : 'none',
      segmentSource: input.segment.sourceRaw,
      sourceBefore: input.sourceBefore,
      targetBefore: input.targetBefore,
      expectedTranslation: input.value,
      activation: {
        attempted: input.activationAttempted,
        ok: input.activationOk
      },
      inputMethod: 'chrome-debugger',
      targetAfter: input.targetAfter,
      confirmation: {
        ok: input.confirmationOk,
        attempts: CONFIRM_ATTEMPTS
      },
      nearbyRows: this.options.collectNearbyRows(input.segment.rowNumber)
    } as MemoqFillDiagnostic;
  }
}
```

- [ ] **Step 5: Delegate `MemoqAdapter.fillSegment` to transaction**

In `memoq-adapter.ts`, import:

```ts
import { MemoqFillTransaction } from './memoq-fill-transaction.ts';
import { writeTrustedTextToElement } from './trusted-text-writer.ts';
```

Replace `fillSegment` with:

```ts
async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
  const profile = this.getProfile();
  const reader = this.getRowReader();

  if (!profile || !reader) {
    return {
      domId: segment.domId,
      filled: false,
      reason: 'memoQ editor profile was not found.'
    };
  }

  const transaction = new MemoqFillTransaction({
    profile,
    readTargetText: (target) => reader.getEditableValue(target),
    readSourceText: (currentSegment) => reader.getCurrentSourceValue(currentSegment),
    collectNearbyRows: (rowNumber) => reader.collectVisibleRowDiagnostics(rowNumber),
    writeTrustedText: (target, text) =>
      writeTrustedTextToElement(target, text, {
        requestType: 'MEMOQ_DEBUGGER_WRITE_TEXT',
        settleMs: 20
      })
  });

  const outcome = await transaction.fillSegment(segment, value);
  if (!outcome.filled && outcome.diagnostic) {
    return {
      ...outcome,
      reason: describeMemoqFillDiagnostic(outcome.diagnostic)
    };
  }

  return outcome;
}
```

Add the missing import:

```ts
import { describeMemoqFillDiagnostic } from './memoq-fill-diagnostics.ts';
```

- [ ] **Step 6: Replace hidden-input-specific tests**

In `tests/memoq-accessibility.test.ts`, remove tests that assert:

- `MemoqAdapter.fillSegment requires the normal memoQ hidden input`
- `MemoqAdapter.fillSegment writes through the normal memoQ hidden input`
- `MemoqAdapter.fillSegment activates memoQ targets through trusted background input`
- `MemoqAdapter.fillSegment retries the trusted click once when the first write lands nowhere`

Those behaviors are replaced by `tests/memoq-fill-transaction.test.ts` and `tests/trusted-text-writer.test.ts`.

- [ ] **Step 7: Verify transaction and adapter tests**

Run:

```powershell
npm test -- tests/memoq-fill-transaction.test.ts
npm test -- tests/memoq-accessibility.test.ts
npm test -- tests/trusted-text-writer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add memoq-fill-transaction.ts tests/memoq-fill-transaction.test.ts memoq-adapter.ts tests/memoq-accessibility.test.ts types.ts
git commit -m "Add verified memoQ fill transaction"
```

---

### Task 6: Shrink memoQ Adapter And Remove Obsolete Click Path

**Files:**
- Modify: `memoq-adapter.ts`
- Modify: `background.ts`
- Modify: `types.ts`
- Modify: `tests/memoq-accessibility.test.ts`

- [ ] **Step 1: Remove unused memoQ adapter internals**

After Task 5, remove these obsolete private methods and constants from `memoq-adapter.ts` if no references remain:

```ts
const MEMOQ_CELL_SELECTOR = '.editor-cell';
const MEMOQ_CONTENT_SELECTOR = '.content-container';
const MEMOQ_HIDDEN_INPUT_SELECTOR = '#editorHiddenInput';
const MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR = 'textarea, input[type="text"]';
const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;
const MEMOQ_COMMIT_CONFIRM_ATTEMPTS = 14;
const MEMOQ_COMMIT_CONFIRM_DELAY_MS = 150;
const MEMOQ_ACTIVATION_DELAY_MS = 20;
const MEMOQ_FILL_ATTEMPTS = 2;
const MEMOQ_LAYOUT_STABLE_CHECK_DELAY_MS = 70;
const MEMOQ_LAYOUT_STABLE_MAX_CHECKS = 8;
```

Remove methods that were moved to profiles, row reader, text helper, trusted writer, or transaction:

```ts
writeValueThroughHiddenInput
findMemoqRowContainer
extractMemoqSegment
waitForCommittedTargetCellText
buildMemoqFillFailureReason
collectVisibleRowDiagnostics
describeActiveElement
readMemoqElementRawText
warnIfNoBreakSpacesConverted
readMemoqElementText
truncateDiagnostic
findCurrentMemoqTargetCellByRowNumber
hasClickableRect
extractMemoqRowNumberWithoutScrollContext
extractMemoqRowNumber
extractMemoqRowNumberFromChildren
dedupeVisibleSegments
findMemoqScrollContainer
findMemoqInteractionTarget
activateTarget
waitForClickableTarget
dispatchTrustedMouseClick
```

Keep `prepareTrustedInput()` because `content-script.ts` pre-attaches the debugger before memoQ scans.

- [ ] **Step 2: Remove memoQ click request from types**

Delete this interface from `types.ts`:

```ts
export interface MemoqDebuggerClickRequest {
  type: 'MEMOQ_DEBUGGER_CLICK';
  payload: {
    x: number;
    y: number;
  };
}
```

Remove `MemoqDebuggerClickRequest` from `BackgroundRequest`.

- [ ] **Step 3: Remove memoQ click-only background handler**

In `background.ts`, delete:

```ts
async function dispatchTrustedTabClick(tabId: number, x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Invalid memoQ click coordinates.');
  }

  await ensureDebuggerAttached(tabId);
  await dispatchTrustedMemoqClick({ tabId }, x, y);
  scheduleDebuggerIdleDetach(tabId);
}
```

Delete the `MEMOQ_DEBUGGER_CLICK` case from `handleMessage`.

Keep `dispatchTrustedMemoqClick` because `dispatchTrustedTextWrite` uses it before `Input.insertText`.

- [ ] **Step 4: Search for old click request usage**

Run:

```powershell
rg -n "MEMOQ_DEBUGGER_CLICK|dispatchTrustedMouseClick|editorHiddenInput|writeValueThroughHiddenInput" .
```

Expected: no matches in source files. Matches in old docs are acceptable only under `docs/superpowers/plans/2026-05-11-memoq-fill-execution-rewrite.md`.

- [ ] **Step 5: Verify full suite**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add memoq-adapter.ts background.ts types.ts tests/memoq-accessibility.test.ts
git commit -m "Shrink memoQ adapter facade"
```

---

### Task 7: Add Modern memoQ Profile Coverage To Adapter Flow

**Files:**
- Modify: `tests/memoq-row-reader.test.ts`
- Modify: `tests/memoq-fill-transaction.test.ts`
- Modify: `tests/memoq-dom-profile.test.ts`
- Modify: `memoq-dom-profile.ts`

- [ ] **Step 1: Add a modern fixture helper**

In `tests/memoq-dom-profile.test.ts`, add this helper near the top:

```ts
function modernMemoqFixture(source: string, target = '', rowNumber = '1123'): FakeElement {
  return fakeElement({
    children: [
      fakeElement({
        className: 'ProseMirror',
        textContent: 'translation memory pane',
        attributes: { contenteditable: 'false' }
      }),
      fakeElement({
        attributes: { role: 'table', 'aria-label': 'translation area' },
        children: [
          fakeElement({
            attributes: { role: 'row' },
            children: [
              fakeElement({
                className: 'ProseMirror',
                textContent: source,
                attributes: {
                  contenteditable: 'true',
                  role: 'gridcell',
                  'aria-label': `row ${rowNumber} source segment`
                }
              }),
              fakeElement({
                className: 'ProseMirror',
                textContent: target,
                attributes: {
                  contenteditable: 'true',
                  role: 'gridcell',
                  'aria-label': `row ${rowNumber} target segment`
                }
              })
            ]
          })
        ]
      })
    ]
  });
}
```

Use it in the existing modern profile tests so all modern fixtures include a read-only ProseMirror pane outside the table.

- [ ] **Step 2: Add source and target side detection test**

Append this test to `tests/memoq-dom-profile.test.ts`:

```ts
test('modern profile keeps source and target sides stable when DOM order is target then source', () => {
  withDocument(
    fakeElement({
      children: [
        fakeElement({
          attributes: { role: 'table', 'aria-label': 'translation area' },
          children: [
            fakeElement({
              attributes: { role: 'row' },
              children: [
                fakeElement({
                  className: 'ProseMirror',
                  textContent: 'Target',
                  attributes: {
                    contenteditable: 'true',
                    role: 'gridcell',
                    'aria-label': 'row 1123 target segment'
                  }
                }),
                fakeElement({
                  className: 'ProseMirror',
                  textContent: 'Source',
                  attributes: {
                    contenteditable: 'true',
                    role: 'gridcell',
                    'aria-label': 'row 1123 source segment'
                  }
                })
              ]
            })
          ]
        })
      ]
    }),
    () => {
      const row = modernEditorMemoqProfile.findVisibleRows(document)[0];
      const cells = modernEditorMemoqProfile.findCells(row);

      assert.equal(cells?.source.textContent, 'Source');
      assert.equal(cells?.target.textContent, 'Target');
    }
  );
});
```

- [ ] **Step 3: Verify modern profile supports accessible labels from actual memoQ wording**

If the browser observation has labels in another language, encode the fixture safely by using `String.fromCharCode` in the test. Add a test like this:

```ts
test('modern profile reads row numbers from localized accessible labels', () => {
  const rowWord = String.fromCharCode(0x884c);
  const sourceText = String.fromCharCode(0x539f, 0x6587);
  const targetText = String.fromCharCode(0x76ee, 0x6807);

  withDocument(
    fakeElement({
      children: [
        fakeElement({
          attributes: { role: 'table', 'aria-label': 'translation area' },
          children: [
            fakeElement({
              attributes: { role: 'row' },
              children: [
                fakeElement({
                  className: 'ProseMirror',
                  textContent: 'Source',
                  attributes: {
                    contenteditable: 'true',
                    role: 'gridcell',
                    'aria-label': `${rowWord} 1123, ${sourceText} segment`
                  }
                }),
                fakeElement({
                  className: 'ProseMirror',
                  attributes: {
                    contenteditable: 'true',
                    role: 'gridcell',
                    'aria-label': `${rowWord} 1123, ${targetText} segment`
                  }
                })
              ]
            })
          ]
        })
      ]
    }),
    () => {
      const row = modernEditorMemoqProfile.findVisibleRows(document)[0];
      assert.equal(modernEditorMemoqProfile.readRowNumber(row), '1123');
    }
  );
});
```

- [ ] **Step 4: Update profile label matching if needed**

If Step 3 fails, update `memoq-dom-profile.ts` label helpers:

```ts
const LOCALIZED_SOURCE_RE = /source|original|\u539f\u6587/i;
const LOCALIZED_TARGET_RE = /target|\u76ee\u6807/i;
const LOCALIZED_ROW_NUMBER_RE = /(?:row|line|\u884c)\s*(\d+)|(\d+)/i;
```

Use these constants in `findCells` and `readModernRowNumberFromLabel`.

- [ ] **Step 5: Verify modern profile tests**

Run:

```powershell
npm test -- tests/memoq-dom-profile.test.ts
npm test -- tests/memoq-row-reader.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add memoq-dom-profile.ts tests/memoq-dom-profile.test.ts tests/memoq-row-reader.test.ts tests/memoq-fill-transaction.test.ts
git commit -m "Cover modern memoQ profile flow"
```

---

### Task 8: Final Integration Verification

**Files:**
- Modify only if verification reveals a concrete issue.

- [ ] **Step 1: Search for boundary leaks**

Run:

```powershell
rg -n "querySelector|querySelectorAll|editor-cell|ProseMirror|editorHiddenInput|MEMOQ_DEBUGGER_CLICK" memoq-adapter.ts memoq-fill-transaction.ts memoq-row-reader.ts memoq-dom-profile.ts trusted-text-writer.ts
```

Expected:

- `memoq-dom-profile.ts` may contain `querySelector`, `querySelectorAll`, `.editor-cell`, and `ProseMirror`.
- `trusted-text-writer.ts` may contain no memoQ selectors.
- `memoq-fill-transaction.ts` may contain no DOM selectors.
- `memoq-row-reader.ts` may contain no `.editor-cell`, `ProseMirror`, or `editorHiddenInput`.
- `memoq-adapter.ts` may contain no `.editor-cell`, `ProseMirror`, `editorHiddenInput`, or `MEMOQ_DEBUGGER_CLICK`.

- [ ] **Step 2: Run full verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```powershell
git diff --stat
git diff -- memoq-adapter.ts
```

Expected:

- `memoq-adapter.ts` is materially smaller.
- New memoQ files hold focused responsibilities.
- No Phrase or GientTrans internals are rewritten.

- [ ] **Step 4: Commit verification fixes if any were needed**

If Step 1 or Step 2 required code changes, commit those changes:

```powershell
git add memoq-adapter.ts memoq-fill-transaction.ts memoq-row-reader.ts memoq-dom-profile.ts trusted-text-writer.ts tests
git commit -m "Verify memoQ refactor boundaries"
```

If no changes were needed, do not create an empty commit.
