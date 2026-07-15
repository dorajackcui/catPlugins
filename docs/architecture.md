# Architecture

The extension has three runtime entry points at the repository root:

- `background.ts` wires the service worker and background request handling.
- `content-script.ts` wires editor-page scanning and fill execution.
- `popup.ts` wires the popup UI.

Supporting code is grouped by responsibility:

- `background/` contains Chrome-side services: debugger input, supported editor URLs, Excel conversion, and persisted state.
- `content/` contains page-side infrastructure: DOM helpers, segment traversal, start markers, fill orchestration, and trusted text writes.
- `domain/` contains business rules for matching, fill options, failure policy, throttling, and run state. These modules should not perform Chrome API calls or mutate editor DOM.
- `platforms/` owns editor-specific selectors, text normalization, row discovery, and writes for memoQ, GientTrans, and Phrase.
- `popup/` separates popup workflow coordination from DOM rendering and downloads.
- `shared/` contains cross-layer Chrome wrappers, message/state contracts, and general utilities.
- `tests/` mirrors these boundaries with direct unit and adapter regression coverage.

## memoQ DOM profiles

memoQ supports two editor generations behind one stable profile API:

- `platforms/memoq/dom-profile.ts` registers profiles, selects the active profile, and resolves start markers.
- `platforms/memoq/modern-dom-profile.ts` owns modern ProseMirror selectors and row identity rules.
- `platforms/memoq/legacy-dom-profile.ts` owns legacy WebTrans cell and row rules.
- `platforms/memoq/dom-profile-types.ts` is the contract for adding another editor generation.
- `platforms/memoq/dom-profile-helpers.ts` contains DOM primitives shared by profile implementations.
- `platforms/memoq/scroll-context.ts` resolves native scroll containers and owns synthetic memoQ navigation events.

Profile selection prefers a fully visible modern editor, then a fully visible legacy editor. A matching
but incomplete modern surface must not hide a usable legacy editor.

### memoQ fill pipeline

- `platforms/memoq/fill-transaction.ts` orchestrates target lookup, trusted input, and the stop-safe sequence.
- `platforms/memoq/fill-validation.ts` validates the current source and empty target before each write.
- `platforms/memoq/fill-confirmation.ts` owns commit polling and row re-resolution.
- `platforms/memoq/fill-diagnostic-builder.ts` creates stable success and failure diagnostics.

## Dependency rules

1. Root entry points assemble dependencies and register listeners; they should not accumulate platform algorithms.
2. Platform selectors and editor write mechanics stay inside `platforms/`.
3. Cross-platform scan and fill flow stays inside `content/` and calls platform ports instead of querying editor DOM directly.
4. Background-only Chrome lifecycle and persistence stay inside `background/`.
5. `shared/` must remain platform-neutral and must not import entry points.

## Preserved platform behavior

- memoQ prepares trusted debugger input before scanning, re-resolves rows during a transaction, and stops on an unconfirmed fill.
- GientTrans may overwrite a non-empty target and retains its native/editor fallback write sequence.
- Phrase uses trusted debugger input, preserves tag-button insertion order, and stops on a failed fill.

Changes to these invariants require explicit behavior tests in addition to the full test, typecheck, and build gates.
