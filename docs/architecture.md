# Architecture

The extension has three runtime entry points at the repository root:

- `background.ts` wires the service worker and background request handling.
- `content-script.ts` wires editor-page scanning and fill execution.
- `popup.ts` wires the popup UI.

Supporting code is grouped by responsibility:

- `background/` contains Chrome-side services: debugger input, editor-frame routing, Excel conversion, and persisted state. The user selects the editor platform in the popup; Preview, Fill, and Export carry that platform to the content runtime without a URL whitelist. The runtime scans only the selected platform. The stored selection is initially empty and cannot change during a run.
- `content/` contains page-side infrastructure: DOM helpers, segment traversal, start markers, fill orchestration, and trusted text writes.
- `domain/` contains business rules for matching, inline-markup canonicalization, fill options, failure policy, throttling, and run state. These modules should not perform Chrome API calls, mutate editor DOM, or import platform implementations.
- `platforms/` owns editor-specific selectors, DOM serialization, row discovery, and writes for memoQ, GientTrans, and Phrase.
- `popup/` contains popup workflow coordination, DOM rendering, and the HTML/CSS source assets copied into the extension package.
- `scripts/` contains build, test, and architecture-check tooling.
- `shared/` contains cross-layer Chrome wrappers, message/state contracts, and general utilities.
- `tests/` mirrors these boundaries with direct unit and adapter regression coverage.
- `types/` contains ambient declarations used during typechecking.

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
- `platforms/start-marker-dom.ts` owns editor-specific click/focus target discovery while exposing one start-marker surface to the root composition.

The root `content-script.ts` only assembles browser-backed ports and registers listeners. The runner
must prepare memoQ trusted input before the scanner captures its first DOM snapshot. The segment
processor remains platform-neutral except for explicit behavior policies exposed by platform and
domain modules.

## Domain matching and markup

- `domain/gientrans-markup.ts` canonicalizes GientTrans tokens and XML-like markup for both matching and editor writes.
- `domain/phrase-source-matching.ts` matches numbered Phrase exports by segment number and source, and unnumbered spreadsheets by source text.
- `domain/phrase-marker-fill.ts` resolves original labels against the current source and checks the written target.
- `domain/memoq-fill-diagnostics.ts` formats stable user-facing stop reasons from platform-neutral diagnostic data.

Keeping these pure rules in `domain/` prevents Phrase and memoQ readers from depending indirectly on another platform implementation through shared QA.

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
- `background/editor-session.ts` owns content-script injection, editor frame selection, content responses, and stop-message routing for the active tab.
- `background/debugger-session.ts` owns serialized Chrome Debugger attachment, fresh-attach settling, keep-alive, external detach, and idle release.
- `background/debugger-input.ts` validates and dispatches trusted click/text operation sequences through that session.

Run workflows should use `BackgroundEditorSession` rather than selecting frames or constructing
`sendTabMessage` options themselves. Stored run targets retain their original tab and frame so Stop
does not reinject the content script or drift to a newly focused tab.

`domain/run-stop.ts` defines the cross-context user-stop error and its display mapping. Content,
background, and popup code must use this contract so an intentional stop never appears as a failure.
If a stopped editor is reloaded before it acknowledges the request, the popup checks
the original tab and frame. Chrome reporting that the receiver is gone releases the
stopping state and preserves the counts. Other messaging errors leave the run pending.

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

Preview and Fill classify the same serializable segment data. Classification
returns the preview item and the validated plan for the matched workbook entry.
Only the active Fill receives the plan. Stored previews contain the item alone.

- `platforms/memoq/editor-writer.ts` selects plain input, whole-target webTrans input,
  or sequential F9 input for the current editor. If a webTrans plan loses its
  required editor capability, the writer stops before editing.
- `platforms/memoq/fill-transaction.ts` orchestrates target lookup, trusted input, and the stop-safe sequence.
- `platforms/memoq/fill-validation.ts` validates the current source and empty target before each write.
- `platforms/memoq/fill-confirmation.ts` owns commit polling and row re-resolution.
- `platforms/memoq/fill-diagnostic-builder.ts` creates stable success and failure diagnostics.

Marker fills use the following components.

- `domain/memoq-file-tags.ts` recognizes file tags from the current source and
  defines the short-tag notation used for both planning and DOM verification.
- `domain/memoq-marker-mapping.ts` aligns the source text and tag positions.
  A webTrans row supplies the native chips observed in its source cell. The
  mapper resolves every target occurrence against those IDs and kinds. Targets
  may repeat, reorder, regroup or omit them. A foreign tag or ambiguous raw
  label rejects the row before input. The sequential F9 writer requires the
  original order and adjacent groups.
- `domain/memoq-marker-fill.ts` validates the translation and builds the complete
  target for webTrans. Only the F9 plan allocates sentinels for cursor movement.
- `platforms/memoq/webtrans-input.ts` focuses and re-resolves the empty webTrans
  target for plain and tagged rows, then sends the complete translation to the
  focused input in one trusted text operation. If webTrans absorbs a focus
  click while saving the previous row, the writer can re-resolve the target and
  retry that click once before input. A beforeinput guard checks the row at
  dispatch. Success requires consecutive reads of the expected text. Tagged
  translations also require native chips at the expected positions.
- `platforms/memoq/marker-editor.ts` binds the modern editor profile to trusted
  input, exact reads, numeric-placeholder escaping, and row re-resolution.
- `platforms/memoq/marker-caret.ts` maps a serialized text offset to a DOM
  caret on the freshly resolved row. A trusted click goes directly to the
  boundary when a browser hit test resolves to that text node and offset.
  Otherwise the writer uses absolute grapheme navigation from the text origin.
- `platforms/memoq/marker-fill-executor.ts` owns the write/delete/F9 sequence and
  the Undo history for its own writes. `marker-state-monitor.ts` owns exact
  stability polling and the final hold, shared by forward writes and rollback.

Fill automatically matches workbooks using short marker IDs or original file
tags. For original tags it aligns the Excel source with the native IDs in the
current row. Preview and Fill leave the tag display untouched. Older workbooks
with a short source and a file-tag target can supply the mapping in
`originalSource`. Export collects that optional column from webTrans’s long
`mq:rxt` labels and restores the previous display. The chip’s `data-tagid`
identifies the native marker in either view.
The classic webTrans grid recycles rows behind its own vertical scrollbar.
Export starts at the top of the filtered grid, reads through the bottom arrow's
disabled state, and restores the scroll position. A numbered `not-loaded-row`
can already show its document ID while the source is still empty. Export waits
for these cells and refreshes their tag display when webTrans has retained the
placeholder. On grids exposing zero-based filtered positions, every position
must resolve to its document row in order. A layout change can require backing
up to collect a missed position. A loaded row with an empty source keeps its
place in the workbook. Unread rows and scan limits stop the export before a
workbook is created.
Numbered rows imported with the export's occurrence column match only their
own row number in memoQ, including after a change of filter or order.
The XLSX stores source and target text with the whitespace exposed by the
editor, including repeated and nonbreaking spaces. Fill reports the number of
rows written. The current filter can change between runs, so the previous
scan cannot supply a reliable total.

Supported file-tag mappings include line-break-only and fully protected Excel markup.
LF, CRLF, and CR each count as one break. The mapper compares source skeletons
before whitespace normalization. Markup left as plain text by the import filter
stays literal. For other delimited file tags, the mapper can derive their
delimiters from protected gaps in the row. The complete source must still align
in text, count and positions. When the same raw spelling denotes several IDs,
the existing source order preserves their identity. A changed sequence that
needs an ambiguous ID requires the short-tag export.

webTrans checks the current source and empty target,
then uses a single text insertion. A mismatch stops the run. webTrans messages are scoped
to its editor frame, including when that frame is the top document.
The modern editor writer deletes each anchor and issues one F9 per native sequence. Each edit requires
six exact reads, 20 ms apart once the edit appears. While the previous value
is still visible, the writer polls for up to 60 ms at this short interval.
A missing, slow or unstable result uses the full 120 ms polling cadence. The initial text
write and Undo use the full cadence, and the finished target must hold for
1.5 seconds. If the target changes between confirmation and positioning, the
run stops before sending the next key or undoing an unrelated edit.

Set `CHROME_BIN` to the path of a Chromium or Chrome for Testing executable
and run `npm run test:memoq-browser` to exercise the built extension with a
temporary Chrome profile and a loopback webTrans fixture. The test imports an
Excel workbook, verifies one trusted text event per target and checks that a
literal tag stops the run before it touches the next row.

## Phrase adapter

- `platforms/phrase/row-reader.ts` reads the translation grid through its own scroll container and serializes each native chip using its original label, editor ID and position. Generic editable discovery runs on pages without the Phrase grid.
- `platforms/phrase/editor-writer.ts` owns trusted Phrase activation, text/tag input, and confirmation polling.
- `platforms/phrase/adapter.ts` composes the reader and writer behind the common platform runtime port.

Preview and Fill check the document row number and source text when the workbook supplies row numbers. For an unnumbered workbook, every matching source must have the same translation. A filtered scan can start on any occurrence of a repeated source.

Export keeps the original labels in the source and target cells. For an existing target in a tagged row, a hidden column records the native marker IDs and positions. Reimport uses that metadata when the target text is the same and each marker still exists in the matching source row. Editing the target cell uses the same source-label matching as a regular upload.

All native rows use the same writer. It re-resolves the source row and verifies the empty target before the trusted focus click. Input is allowed only while the intended target owns the active editor input. The writer uses the insert-tag button for the next available source chip and the numbered shortcut to select a different chip. It can omit unused chips and copy an already inserted chip through the editor's clipboard events. An ambiguous label with several source IDs or an unsupported first insertion stops before entering text. Confirmation checks target text and all native chips at their expected positions.

Phrase DOM changes should be contained in the reader or writer rather than adding selectors to the
adapter orchestration layer.

## GientTrans adapter

GientTrans run messages target the top frame when the tab opens the `olEditor` route directly. For an embedded editor, the session selects the frame with that route. A custom URL without a recognized route uses the top frame. Only the selected frame answers the scan, so a hidden auxiliary iframe cannot return an empty result ahead of the editor. Export reports an error when the scan finds zero segments.

Export writes each native chip's `equiv-text` in its source spelling, including XML angle brackets. A paired XLIFF group can supply the closing name through its opening chip with the same `tid`. A placeholder with empty `equiv-text` keeps its full XLIFF tag and ID. Fill maps these spellings back to the current row’s native chips.

- `platforms/gientrans/row-reader.ts` owns table discovery, scrolling, and target lookup by `segid`.
- `platforms/gientrans/editor-tags.ts` reads native chip identities, resolves their original spelling, and pairs the current row’s opening and closing chips for reuse in the translation.
- `platforms/gientrans/editor-text.ts` serializes editor content for Export and prepares both the plain text and editor HTML used by Fill. It preserves whitespace inside mapped chips.
- `platforms/gientrans/editor-writer.ts` tries paste, text insertion, HTML insertion, then direct replacement. Targets containing native chips or nonbreaking spaces skip plain-text insertion. Confirmation checks the resulting text and native chip sequence.
- `platforms/gientrans/adapter.ts` activates the current target, coordinates the write, dispatches editor events, and returns the confirmation result. Scan and write diagnostics share `platforms/gientrans/diagnostics.ts`.

GientTrans must remain the only platform that may overwrite non-empty targets. Reader refactors must
retain `segid` target re-resolution so virtualized table rows are not written through stale elements.

## Dependency rules

1. Root entry points assemble dependencies and register listeners; they should not accumulate platform algorithms.
2. Platform selectors and editor write mechanics stay inside `platforms/`.
3. Cross-platform scan and fill flow stays inside `content/` and calls platform ports instead of querying editor DOM directly.
4. Background-only Chrome lifecycle and persistence stay inside `background/`.
5. `shared/` must remain platform-neutral and must not import entry points.
6. Pure matching and markup canonicalization stay in `domain/`; domain modules must not import `platforms/`.
7. `content/` may import public modules at the root of `platforms/`, but not a platform implementation subfolder.

## Preserved platform behavior

- memoQ prepares trusted debugger input before scanning, re-resolves rows during a transaction, and stops on an unconfirmed fill.
- GientTrans may overwrite a non-empty target and retains its native/editor fallback write sequence.
- Phrase uses trusted debugger input, preserves tag-button insertion order, and stops on a failed fill.

Changes to these invariants require explicit behavior tests in addition to the full test, typecheck, and build gates.

Run `npm run check:architecture` to enforce the root-entrypoint layout, tooling and declaration placement,
focused shared-contract imports, shared-layer neutrality, platform isolation, popup dependency direction,
domain independence, and reader/adapter DOM boundary.
