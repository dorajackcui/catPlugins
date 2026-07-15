# Phrase Bulk Fill

Chrome Manifest V3 extension for importing Excel translations, previewing source matches, and filling Phrase, memoQ, and GientTrans editors.

## Development

Requirements: a current Node.js LTS release and npm.

```powershell
npm ci
npm run check:architecture
npm run typecheck
npm test
npm run build
```

The build writes an unpacked extension to `dist/`. Load that directory from `chrome://extensions` with Developer mode enabled. `dist/` and root-level Excel workbooks are intentionally ignored by Git.

## Source layout

- `background.ts`, `content-script.ts`, and `popup.ts` are composition roots only.
- `background/` owns Chrome services, run lifecycle, editor-frame routing, Excel conversion, and debugger sessions.
- `content/` owns page-run coordination, segment traversal, fill execution, stop handling, and content message routing.
- `domain/` owns browser-independent matching, QA, throttling, run-state, and failure policies.
- `platforms/` owns Phrase, memoQ, and GientTrans DOM readers and editor writers.
- `popup/` owns popup workflows, run monitoring, view rendering, and static source assets.
- `shared/` owns focused message, state, fill-result, storage, and translation contracts.
- `tests/` mirrors those boundaries with unit, state-machine, adapter, and DOM regression coverage.

See [docs/architecture.md](docs/architecture.md) for dependency rules and module-level responsibilities.

## Platform invariants

- memoQ prepares trusted debugger input before its first scan, re-resolves virtualized rows before writing, and stops after an unconfirmed fill.
- GientTrans may overwrite a non-empty target and preserves its ordered paste, text, HTML, and direct-HTML fallback transaction.
- Phrase uses trusted debugger input for native rows, preserves tag-button operation order, and stops after a failed fill.

Any platform behavior change requires a focused regression test plus the full architecture, typecheck, test, and build gates.

## Extending the extension

For a new editor integration:

1. Add a platform folder with a DOM reader and editor writer behind a small adapter.
2. Register the adapter in `platforms/runtime.ts` without importing another platform implementation.
3. Add supported URL rules in `background/editor-url.ts` and matching manifest permissions.
4. Add direct reader/writer tests and cross-platform runtime routing coverage.
5. Update `docs/architecture.md` with any new lifecycle or safety invariant.

Keep compatibility barrels for tests and migration only; production modules should import focused contracts directly. Run `npm run check:architecture` before committing to catch boundary regressions.
