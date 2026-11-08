# Phrase Bulk Fill

Chrome Manifest V3 extension for importing Excel translations and filling Phrase, memoQ, and GientTrans editors.

## 极简用法

1. 从 [最新 Release](https://github.com/dorajackcui/catPlugins/releases/latest) 下载 `catPlugins-v*.zip`，解压到固定目录。
2. Chrome 打开 `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择包含 `manifest.json` 的文件夹。
3. 打开待填写的编辑器页面，点击插件，选择 **memoQ**、**Phrase / Memsource** 或 **GientTrans**。
4. 点击 **Choose Excel file** 导入 Excel，再点击 **Fill**。插件读取第一个工作表；建议使用 `source`（原文）和 `target`（译文）列名。
5. **Export** 可先导出原文，填好 `target` 列后重新导入；**Stop current run** 可停止当前任务。

**更新：** 下载新版 ZIP，将解压后的文件覆盖到原插件目录，在 Chrome 扩展页点击「重新加载」，再刷新编辑器页面。

插件会记住上次选择的平台，支持自定义域名和 IP 地址；运行中不能切换平台。

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
- `scripts/` owns build, test, and architecture-check tooling.
- `shared/` owns focused message, state, fill-result, storage, and translation contracts.
- `tests/` mirrors those boundaries with unit, state-machine, adapter, and DOM regression coverage.
- `types/` owns ambient declarations for Chrome, Node's test runner, and the Excel library.

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
3. Add the platform to `shared/editor-platform.ts` and the popup selector. The active tab grant supports user-initiated injection; add manifest permissions only if the integration needs other origins.
4. Add direct reader/writer tests and cross-platform runtime routing coverage.
5. Update `docs/architecture.md` with any new lifecycle or safety invariant.

Keep compatibility barrels for tests and migration only; production modules should import focused contracts directly. Run `npm run check:architecture` before committing to catch boundary regressions.
