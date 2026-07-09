# memoQ Path Refactor Design

Date: 2026-07-09

## Goal

Refactor the memoQ code path so future memoQ UI changes can be handled by adding or updating a small DOM profile instead of editing a large, mixed adapter.

The current `memoq-adapter.ts` mixes version-specific selectors, row scanning, text serialization, target activation, Chrome debugger input, commit confirmation, and failure diagnostics. The next memoQ update needs support for the new `/memoqweb/editor/projects/.../docs/...` editor, whose target cells are visible ProseMirror `contenteditable` elements. Adding that support directly to the current file would make the memoQ path harder to change again.

The refactor should preserve the existing fill runner contract while making memoQ internals easier to reason about and test.

## Non-Goals

- Do not refactor GientTrans internals.
- Do not refactor Phrase internals beyond optionally routing its existing trusted text write through a shared helper.
- Do not change Excel parsing or source matching.
- Do not redesign the popup.
- Do not drop support for the legacy memoQ `webtrans` editor.
- Do not add broad fallback chains that hide unverified writes.

## Current Problems

`memoq-adapter.ts` currently owns too many responsibilities:

- Detecting whether memoQ is active.
- Finding scroll containers.
- Scanning visible rows.
- Serializing memoQ inline tags and whitespace.
- Re-resolving virtualized rows.
- Activating targets.
- Writing through legacy hidden input behavior.
- Dispatching trusted debugger clicks.
- Confirming committed target text.
- Building large failure reasons.

The result is fragile extension work: each new memoQ discovery tends to add another special case to the same file. The repo already has diagnostic types and design notes for a cleaner verified transaction model, but implementation still carries older hidden-input and click-only paths.

## Proposed Architecture

Keep one public `MemoqAdapter` facade, but move the memoQ details behind focused modules.

### `memoq-dom-profile.ts`

Defines a `MemoqDomProfile` contract and exports profile selection.

Each profile answers:

- Does this page match the profile?
- How are visible rows found?
- How are source and target cells found inside a row?
- How is a row number read?
- How is a target activated?
- What element should receive trusted text input?

Initial profiles:

- `legacyWebtransMemoqProfile`
  - Supports the existing `.editor-cell` / hidden-input-era editor.
  - Preserves existing behavior while moving selectors into one profile.
- `modernEditorMemoqProfile`
  - Supports `/memoqweb/editor/projects/.../docs/...`.
  - Uses the translation table role and memoQ-specific accessible labels as the table root.
  - Uses row containers under the translation table.
  - Uses ProseMirror `contenteditable` gridcells whose accessible labels identify row number and source/target side.
  - Activates and writes to the target ProseMirror element.

Profile selection should be explicit and ordered. If no profile matches, memoQ is inactive.

### `memoq-text.ts`

Owns pure text behavior:

- `formatMemoqInlineTag`
- `memoQAccessibilityTextToRenderedText`
- `isMemoqCommittedTargetText`
- memoQ whitespace marker normalization
- memoQ DOM content serialization

This module should not import Chrome APIs or runtime messaging. It should be easy to test without browser mocks.

### `memoq-row-reader.ts`

Reads visible memoQ rows through a selected profile and returns `RuntimeSegment` values.

Responsibilities:

- Sort visible rows and cells by visual position.
- Read source, target, row number, and DOM identity.
- Deduplicate virtualized row duplicates.
- Find the current target row by row number or a conservative visible-source identity.
- Collect nearby row snapshots for diagnostics.

It should not write to the page.

### `memoq-fill-transaction.ts`

Implements one verified fill transaction.

For each matched segment:

1. Re-resolve the current row using `MemoqRowReader`.
2. Verify row identity.
3. Verify source text still matches the matched segment.
4. Verify target text is still empty.
5. Activate the target through the selected profile.
6. Write through trusted text input.
7. Confirm the same row's target text matches the expected translation.
8. Return a success or failure `FillOutcome` with structured memoQ diagnostics.

This module is the only memoQ write path. It should stop on uncertainty instead of trying unrelated fallback methods.

### `trusted-text-writer.ts`

Wraps the existing Chrome debugger text write request.

Responsibilities:

- Measure a visible target element.
- Send one background request that clicks the element and calls Chrome debugger `Input.insertText`.
- Return clear errors when the element cannot be measured or the background request fails.

The helper should support memoQ and Phrase, but adopting it in Phrase should not change Phrase behavior. The memoQ refactor can introduce it first for memoQ and move Phrase in a separate refactor if that keeps implementation smaller.

### `memoq-adapter.ts`

Becomes a facade:

- Select the active `MemoqDomProfile`.
- Create a row reader.
- Return scroll context for the active profile.
- Collect visible segments.
- Delegate fill to `MemoqFillTransaction`.
- Delegate text reads to row reader/text helpers.

The facade should no longer know every selector, hidden input detail, or diagnostic field.

## URL Support

`editor-url.ts` should recognize both memoQ editor URL families:

- Legacy: `/memoqweb/(webpm/)?webtrans/...`
- Modern: `/memoqweb/editor/projects/<projectId>/docs/<docId>`

This change should be tested separately from DOM behavior.

## Data Flow

The existing high-level fill loop remains:

1. `content-script.ts` asks the platform adapter for visible segments.
2. `matcher.ts` classifies uploaded Excel entries against scanned page segments.
3. `content-script.ts` chooses ready segments.
4. For memoQ segments, `MemoqAdapter.fillSegment` delegates to a verified transaction.
5. The transaction writes once and confirms the same row.
6. `content-script.ts` re-scans after a successful memoQ fill, preserving the current safety behavior.

The refactor should not require popup, storage, Excel, or matcher changes beyond type imports if files move.

## Error Handling And Diagnostics

MemoQ fill failures should keep the existing stable failure categories:

- `ROW_NOT_FOUND`
- `ROW_AMBIGUOUS`
- `SOURCE_MISMATCH`
- `TARGET_NOT_EMPTY`
- `FOCUS_FAILED`
- `INPUT_FAILED`
- `CONFIRM_TIMEOUT`
- `SCROLL_STALLED`
- `UNKNOWN_MEMOQ_FILL_ERROR`

`memoq-fill-diagnostics.ts` continues to format user-facing stop reasons. Full diagnostics should include:

- active profile id
- row number and locating method
- source before write
- target before write
- expected translation
- activation result
- input method
- target after write
- confirmation result
- nearby visible rows

The popup receives a concise reason. The console receives enough structured detail to debug the exact failing step.

## Testing Strategy

Add or adjust tests around module boundaries, not only end-to-end adapter behavior.

### Profile Tests

- Legacy profile detects representative old memoQ DOM.
- Modern profile detects representative ProseMirror memoQ DOM.
- Modern profile reads row number, source cell, and target cell from `aria-label` gridcells.
- Modern profile ignores unrelated read-only translation-memory ProseMirror panes.

### Text Tests

- Preserve existing inline tag formatting tests.
- Preserve whitespace marker tests.
- Preserve NBSP comparison behavior.

### Row Reader Tests

- Reads visible segments through the legacy profile.
- Reads visible segments through the modern profile.
- Deduplicates virtualized duplicates.
- Finds current target by row number.
- Reports ambiguity when row identity is not unique.

### Transaction Tests

- Refuses to write when row is missing.
- Refuses to write when source changed.
- Refuses to write when target is no longer empty.
- Writes once through trusted text input.
- Confirms success only from the same resolved row.
- Returns structured diagnostics on confirmation timeout.

### Integration Guard Tests

- `content-script.ts` still re-scans after a successful memoQ fill.
- `editor-url.ts` accepts both old and new memoQ URLs.
- Existing Phrase and GientTrans tests continue to pass.

## Migration Plan

Implement the refactor in small steps:

1. Extract pure memoQ text helpers into `memoq-text.ts` and keep tests passing.
2. Extract trusted text write helper without changing behavior.
3. Introduce the `MemoqDomProfile` contract and legacy profile, still matching current legacy behavior.
4. Move visible-row scanning into `memoq-row-reader.ts`.
5. Move fill execution into `memoq-fill-transaction.ts`.
6. Shrink `memoq-adapter.ts` into the facade.
7. Add modern editor URL detection and modern ProseMirror profile.
8. Add focused modern profile and transaction tests.
9. Remove obsolete hidden-input-only assumptions after tests prove legacy behavior is preserved.

Each step should be separately verifiable with `npm test`, `npm run typecheck`, and `npm run build`.

## Acceptance Criteria

- `memoq-adapter.ts` is a small facade rather than the owner of selectors, text serialization, writer logic, and diagnostics.
- Legacy memoQ tests still pass.
- Modern memoQ editor DOM can be scanned into `RuntimeSegment` values.
- Modern memoQ target fill uses trusted text input against the ProseMirror target cell.
- A memoQ fill transaction has one primary write path and one same-row confirmation path.
- New memoQ DOM changes can usually be handled by editing or adding a profile.
- Phrase and GientTrans behavior remains unchanged.
