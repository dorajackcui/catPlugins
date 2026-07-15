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
- `popup/` contains popup workflow coordination, DOM rendering, and the HTML/CSS source assets copied into the extension package.
- `shared/` contains cross-layer Chrome wrappers, message/state contracts, and general utilities.
- `tests/` mirrors these boundaries with direct unit and adapter regression coverage.

## Content DOM foundation

- `content/types.ts` defines page-side segment, editable element, and scroll contracts.
- `content/scroll.ts` owns generic scroll contexts, container selection, visibility, and visual ordering.
- `content/dom.ts` owns editor DOM queries and input event helpers, while extending the scroll helper as a compatibility facade.

Modules that only need `RuntimeSegment` or `ScrollContext` should import `content/types.ts`. Platform
scroll resolvers should depend on `ContentScrollHelpers` unless they also need editor DOM operations.

## Fill execution

- `content/request-handler.ts` routes the typed content-script protocol and normalizes request options.
- `content/run-service.ts` owns page-run stop state, scan result serialization, and composition of the scanner and fill runner.
- `content/fill-runner.ts` owns run-level preparation, scanner startup, and completion logging.
- `content/fill-segment-processor.ts` owns per-segment classification, write safety, progress, throttling, stop conditions, and rescan decisions.
- `content/fill-runner-contracts.ts` defines the scanner, runtime, and reporting ports shared by those layers.

The root `content-script.ts` only assembles browser-backed ports and registers listeners. The runner
must prepare memoQ trusted input before the scanner captures its first DOM snapshot. The segment
processor remains platform-neutral except for explicit behavior policies exposed by platform and
domain modules.

## Shared contracts

- `shared/translation-types.ts` defines workbook, preview, and fill-run data.
- `shared/state-types.ts` defines runtime and popup state.
- `shared/fill-outcome-types.ts` defines platform fill results and memoQ diagnostics.
- `shared/message-types.ts` defines background/content request and response protocols.
- `shared/storage-keys.ts` is the runtime source of persisted Chrome storage keys.
- `shared/types.ts` is a compatibility barrel; production modules should import the focused contract directly.

## Background run routing

- `background/request-handler.ts` routes extension messages to state, run, workbook, and debugger services.
- `background/run-coordinator.ts` owns Preview, Export, Fill, and Stop lifecycle rules and user-facing status updates.
- `background/run-lifecycle.ts` owns persisted start, finish, failure, and stopping state transitions shared by every run kind.
- `background/editor-session.ts` is the single owner of active-tab validation, content-script injection, Phrase iframe selection, content response unwrapping, and stop-message routing.
- `background/debugger-session.ts` owns serialized Chrome Debugger attachment, fresh-attach settling, keep-alive, external detach, and idle release.
- `background/debugger-input.ts` validates and dispatches trusted click/text operation sequences through that session.

Run workflows should use `BackgroundEditorSession` rather than selecting frames or constructing
`sendTabMessage` options themselves. Stored run targets retain their original tab and frame so Stop
does not reinject the content script or drift to a newly focused tab.

`domain/run-stop.ts` defines the cross-context user-stop error and its display mapping. Content,
background, and popup code must use this contract so an intentional stop never appears as a failure.

## Popup application

- `popup/controller.ts` owns Upload, Preview, Export, Fill, and option-persistence workflows.
- `popup/contracts.ts` defines the stable file, view, and controller ports shared by popup layers.
- `popup/run-monitor.ts` owns busy/stopping state, run-state rendering, refresh polling, and Stop request gating.
- `popup/view.ts` owns DOM bindings, form parsing, preview rendering, and file downloads.

New popup commands should compose these layers instead of creating another timer or duplicating
busy/stopping state in a workflow handler.

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

## Phrase adapter

- `platforms/phrase/row-reader.ts` owns Phrase row selectors, generic editable fallback discovery, tag-chip detection, scroll-container selection, and segment serialization.
- `platforms/phrase/editor-writer.ts` owns trusted Phrase activation, text/tag input, and confirmation polling.
- `platforms/phrase/adapter.ts` composes the reader and writer behind the common platform runtime port.

Phrase DOM changes should be contained in the reader or writer rather than adding selectors to the
adapter orchestration layer.

## GientTrans adapter

- `platforms/gientrans/row-reader.ts` owns table selectors, scroll-container selection, segment serialization, target re-resolution, source-tag lookup, and scan diagnostics.
- `platforms/gientrans/editor-text.ts` owns editor text/tag serialization and translation-to-editor HTML conversion.
- `platforms/gientrans/diagnostics.ts` defines stable text diagnostics shared by scanning and writing.
- `platforms/gientrans/editor-writer.ts` owns native contenteditable write mechanics and confirmation polling.
- `platforms/gientrans/adapter.ts` preserves the ordered paste/text/HTML/fallback write transaction behind the common runtime port.

GientTrans must remain the only platform that may overwrite non-empty targets. Reader refactors must
retain `segid` target re-resolution so virtualized table rows are not written through stale elements.

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

Run `npm run check:architecture` to enforce the root-entrypoint layout, focused shared-contract imports,
shared-layer neutrality, platform isolation, popup dependency direction, domain browser independence,
and reader/adapter DOM boundary.
