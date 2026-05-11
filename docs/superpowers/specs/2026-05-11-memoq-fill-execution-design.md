# memoQ Fill Execution Rewrite Design

Date: 2026-05-11

## Goal

Rewrite only the memoQ fill execution chain so a fill run can automatically move downward through the memoQ editor and accurately fill every safe, matching, empty target segment.

Accuracy is the priority. The implementation may be slower, and it may stop early when it cannot prove the next write is safe, but it must not keep going after losing row identity or target certainty.

## Non-Goals

- Do not change how uploaded Excel rows are parsed or matched to page sources.
- Do not redesign Phrase filling.
- Do not build a broad fallback stack of unrelated fill methods.
- Do not continue filling after an unverified write, a possible row jump, or source mismatch.

## Existing Boundaries To Preserve

- `excel.ts` continues to parse `source`, `target`, optional `rowNumber`, and optional `occurrenceIndex`.
- `matcher.ts` continues to decide whether a page segment matches an uploaded Excel entry.
- The fill runner in `content-script.ts` may keep using the existing preview and run-progress model.
- memoQ scanning may be adjusted only if the current scan data prevents accurate fill execution, such as stale targets, missing row identity, or unstable visible-row ordering.

## Proposed Architecture

The memoQ adapter should expose a clean fill execution path centered on one concept: a verified fill transaction.

Each transaction receives a matched runtime segment and its Excel translation. Before writing, it re-identifies the current memoQ row, verifies that the row is still the intended row, verifies that the target is still empty, performs one primary input method, then confirms the committed target text on the same row.

The primary implementation should be small and explicit:

1. Locate the current row.
2. Verify source identity.
3. Verify target emptiness.
4. Activate target and input translation.
5. Confirm same-row commit.
6. Return success or a structured failure.

This should replace the current memoQ fill execution chain rather than layering on more fallback behavior.

## Row Identity

Row identity should prefer `rowNumber` when available. If `rowNumber` is unavailable, the adapter may use source text plus visible-row position only when there is exactly one visible candidate. Any ambiguity stops the transaction.

Before writing:

- The resolved row must exist in the current DOM.
- The row's source text must normalize to the same source as the matched segment.
- The target cell must still normalize to empty.
- If more than one current visible row could match the same identity, the transaction fails with an ambiguity reason.

The source matching rule itself remains unchanged. The transaction only reuses the already-normalized source values to verify that the intended row is still under the cursor.

## Fill Input Method

Use one main input path instead of many stacked fallbacks. The implementation should have one primary writer and one confirmation path.

The preferred path is to activate the memoQ target cell with trusted browser input, focus the active memoQ editor, insert the translation, and let memoQ commit it through its normal editor behavior. The implementation should avoid direct target DOM mutation because direct DOM writes can appear successful without being accepted by memoQ.

If the implementation uses `#editorHiddenInput`, it should be treated as the memoQ editor endpoint, not as a place to fake success. The transaction must still verify the visible target on the resolved row after writing.

## Automatic Downward Filling

The user-facing behavior is one fill command that continues downward automatically.

The fill loop should:

- Start from the top for memoQ fill runs when requested by the background runner.
- Scan the current visible rows.
- Select fillable matched rows from the current visible window.
- Execute verified fill transactions for those rows.
- Re-scan after each successful memoQ fill, because memoQ may replace row DOM after commit.
- Track visited rows by `rowNumber` when possible, otherwise by a conservative source-position key.
- Scroll down when the current visible window has no remaining safe fillable rows.
- Stop when the editor is at the bottom and repeated scans find no new safe fillable rows.

The loop should not rely on an old visible-row snapshot after a write.

## Failure Policy

Failures should be conservative and explainable.

Stop the memoQ fill run when a transaction cannot prove a safe write. Do not skip forward after a row identity failure, write confirmation failure, unexpected source mismatch, focus failure, or scroll instability.

Acceptable skip cases are limited to conditions that are safe and already represented in preview behavior, such as a matched segment whose target is no longer empty before writing.

## Diagnostics

The rewrite must produce complete diagnostic information for failures and useful trace information for successful transactions.

Each transaction should record:

- `runId`
- fill sequence number
- scan pass or visible-window pass
- scroll position
- selected row identity and locating method
- source before write
- target before write
- expected translation
- activation result
- editor/focus state after activation
- input method used
- target after write
- confirmation result
- nearby visible row snapshot

Failure reasons should use stable categories:

- `ROW_NOT_FOUND`
- `ROW_AMBIGUOUS`
- `SOURCE_MISMATCH`
- `TARGET_NOT_EMPTY`
- `FOCUS_FAILED`
- `INPUT_FAILED`
- `CONFIRM_TIMEOUT`
- `SCROLL_STALLED`
- `UNKNOWN_MEMOQ_FILL_ERROR`

The popup should show a concise human-readable stop reason. The console should receive the full structured diagnostic object so the next investigation can start from the failing step rather than guessing.

## Testing

Tests should focus on the clean core behavior:

- A transaction refuses to write when the row cannot be found.
- A transaction refuses to write when the source changed.
- A transaction refuses to write when the target is no longer empty.
- A transaction succeeds only after same-row target confirmation.
- A failed confirmation returns a structured diagnostic with nearby rows.
- The fill loop re-scans after each successful memoQ fill.
- The fill loop scrolls downward when the visible window has no safe fillable rows.
- The fill loop stops at bottom after repeated no-new-row scans.

Existing matcher and Excel tests should remain valid and should not be rewritten except where type changes are required to carry diagnostics.

## Implementation Constraints

- Keep the memoQ fill path readable and small enough to reason about.
- Prefer named helper functions for transaction steps over a large monolithic method.
- Avoid adding broad fallback chains.
- Preserve unrelated working-tree changes.
- Do not change the Excel source matching algorithm.
