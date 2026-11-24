<h1 align="center">Phrase Bulk Fill</h1>

<p align="center">用 Chrome 扩展，把 Excel 里的译文批量填入网页翻译编辑器。</p>

<p align="center"><strong>memoQ · Phrase / Memsource · GientTrans</strong></p>

<p align="center"><a href="https://github.com/dorajackcui/catPlugins/releases/latest"><strong>下载最新版</strong></a></p>

---

## 快速上手

1. **安装。** 下载并解压 `catPlugins-v*.zip`。打开 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。
2. **导入。** 打开翻译编辑器，点击扩展图标并选择平台。用 **Choose Excel file** 导入 `.xlsx` 或 `.xls`。扩展读取第一个工作表，建议用 `source`（原文）和 `target`（译文）作列名。
3. **回填。** 点击 **Fill** 批量填入译文。需要中途停止时，点击 **Stop current run**。

还没有 Excel？点击 **Export** 从编辑器导出工作表，填好 `target` 列后再导入。

在 GientTrans 里，Export 和 Fill 使用同一套原文标签。翻译时可以直接保留 `<color=…>`、`</color>`、`{0}` 等写法。网页只提供 XLIFF 占位符时，Excel 会保留带 ID 的完整标签，回填时会还原成该句段的网页 marker。

在 memoQ 里先筛选需要的句段，再点击 **Export**。每个句段占一行，`source` 使用网页短标签。保留段号和重复序号，填好 `target` 后回到同一份文档，点击 **Fill**。Excel 两列都使用原始文件标签时，也用同一个 **Fill**。

在经典 webTrans 中，译文可以重复、调整顺序或省略本句的标签。原文有 `<1> <2> <3>` 时，译文可以用 `<1><2><2><1>`，也可以只填文字。出现本句没有的标签会跳过该行，弹窗会显示行号和原因。

在经典 webTrans 中，Export 从当前文档筛选结果的第一段扫描到末段，保留网页顺序和已有译文。要导出未锁定、未翻译的句段，请先在网页里设好这两个筛选条件。每次最多导出 10,000 段并扫描 1,200 轮。达到上限且仍有未读句段时，扩展会提示缩小筛选范围。

**Fill** 保留网页当前的标签显示方式。短标签表按编号对应，原始标签表按 Excel 原文与网页句段中的标签顺序、连续分组对应。webTrans 接收整段译文后，扩展会核对文字和原生标签的位置。**Export** 在经典 webTrans 中会临时展开标签读取 `originalSource`，结束后恢复原来的显示。

扩展支持自定义域名和 IP 地址，并会记住上次选择的平台。

**更新扩展：** 将新版 ZIP 解压后覆盖原目录，在 Chrome 扩展页点击「重新加载」，再刷新编辑器页面。

[开发指南](AGENTS.md)
