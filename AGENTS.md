# Development guide

## Local setup and checks

Use Node.js LTS and npm. Install dependencies with `npm ci`, then run the checks and build:

```sh
npm run check:architecture
npm run typecheck
npm test
npm run build
```

To try the build in Chrome, enable Developer mode at `chrome://extensions/` and load `dist/` as an unpacked extension. Use `npm run watch` to rebuild bundles while editing. Git ignores `dist/` and root-level `.xlsx` files.

## Code boundaries

The root entry points (`background.ts`, `content-script.ts`, and `popup.ts`) wire dependencies and register listeners. Keep implementation in the modules they compose:

| Directory | Responsibility |
| --- | --- |
| `background/` | Chrome services, run lifecycle, editor frame routing, Excel conversion, and debugger sessions |
| `content/` | Page run coordination, segment traversal, fill execution, stop handling, and message routing |
| `domain/` | Browser-independent matching, QA, throttling, run state, and failure policies |
| `platforms/` | Editor-specific DOM readers, writers, and adapters |
| `popup/` | Popup workflows, run monitoring, rendering, and static assets |
| `shared/` | Message, state, fill result, storage, and translation contracts |
| `scripts/`, `tests/`, `types/` | Build and check tooling, regression tests, and ambient declarations |

Production code should import focused contracts directly. Keep compatibility barrels for tests and migration. See [Architecture](docs/architecture.md) for dependency rules and module responsibilities.

## Platform behavior

- **memoQ:** Prepare trusted debugger input before the first scan, re-resolve virtualized rows before writing, and stop on an unconfirmed fill.
- **GientTrans:** May overwrite a non-empty target. Preserve the ordered paste, text, HTML, and direct HTML fallback sequence.
- **Phrase:** Use trusted debugger input for native rows, preserve tag button operation order, and stop after a failed fill.

Platform behavior changes require focused regression coverage and all four checks above.

## Add an editor integration

1. Add a folder under `platforms/` with a DOM reader and an editor writer behind an adapter.
2. Register the adapter in `platforms/runtime.ts`. Keep its implementation independent of other platform implementations.
3. Add the platform to `shared/editor-platform.ts` and the popup selector. The active tab grant supports user-initiated injection; add manifest permissions only if the integration needs access to other origins.
4. Test the reader and writer directly, and cover routing in the platform runtime tests.
5. Document any new lifecycle or safety rules in [Architecture](docs/architecture.md).
