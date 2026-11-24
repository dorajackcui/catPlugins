import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGientTransSourceTags, type GientTransSourceTags } from '../platforms/gientrans/editor-tags.ts';
import { normalizeGientTransEditorText, prepareGientTransTarget, readGientTransEditorText } from '../platforms/gientrans/editor-text.ts';
import { makeTagNode } from './gientrans-test-dom.ts';

function tagsByToken(entries: [string, string[]][]): GientTransSourceTags {
  return { byToken: new Map(entries), pairedClosers: new Map() };
}

function renderTarget(value: string, tags?: GientTransSourceTags): string {
  return prepareGientTransTarget(value, tags).html;
}

function sourceWithTagNodes(nodes: ChildNode[]): HTMLElement {
  return {
    childNodes: nodes,
    querySelectorAll: () => nodes.map(node => (node as HTMLElement).querySelector('input'))
  } as unknown as HTMLElement;
}

test('GientTrans restores native tag pairs by action when the translation reorders them', () => {
  const tags = [
    ['❰Orange❱', '0'], ['❰/❱', '1'],
    ['❰input key=&quot;HardLock&quot;❱', '2'], ['❰/❱', '3'],
    ['❰input key=&quot;Jump&quot;❱', '4'], ['❰/❱', '5']
  ].map(([equiv, id]) => makeTagNode(
    `❮ph equiv-text="${equiv}" id="${id}"/❯`,
    `<span data-id="${id}"><input type="tag"></span>`
  ));
  const source = sourceWithTagNodes(tags);
  const sourceTags = collectGientTransSourceTags(source);
  const html = renderTarget(
    '<input key="Jump"></><Orange>S1シーズン（前半）</><input key="HardLock"></>を押す。<br>',
    sourceTags
  );
  const chip = (index: number) => (tags[index] as HTMLElement).outerHTML;
  assert.equal(html,
    chip(4) + chip(5) + chip(0) + 'S1シーズン（前半）' + chip(1) +
    chip(2) + chip(3) + 'を押す。&lt;br&gt;'
  );
});

test('normalizeGientTransEditorText removes editor-only invisible markers', () => {
  assert.equal(
    normalizeGientTransEditorText('Le\u00a0\u200BCocoricou\uFEFF'),
    'Le Cocoricou'
  );
});

test('GientTrans exports complete formatting and locked chips and restores the correct native pairs', () => {
  const first = '❮cf Color="#123456"❯';
  const second = '❮cf Color="#ABCDEF"❯';
  const close = '❮/g❯';
  const locked = '❮ph equiv-text="" id="locked-item"/❯';
  const identities = [
    `❮g equiv-text="${first}" id="a"❯`, close,
    `❮g equiv-text="${second}" id="b"❯`, close, locked
  ];
  const chips = identities.map((_, index) => `<span data-chip="${index}"><input type="tag"></span>`);
  const ids = ['1', '1', '2', '2', '3'];
  const source = sourceWithTagNodes(identities.map((identity, i) => makeTagNode(identity, chips[i], ids[i])));
  assert.equal(readGientTransEditorText(source),
    '<cf Color="#123456"></cf><cf Color="#ABCDEF"></cf><ph equiv-text="" id="locked-item"/>');

  const sourceTags = collectGientTransSourceTags(source);
  assert.equal(
    renderTarget('<cf Color="#ABCDEF">B</cf><ph equiv-text="" id="locked-item"/><cf Color="#123456">A</cf>',
      sourceTags),
    chips[2] + 'B' + chips[3] + chips[4] + chips[0] + 'A' + chips[1]
  );
});

test('nested identical opening chips keep their own closing IDs when translated as siblings', () => {
  const tags = ['❰Orange❱', '❰Orange❱', '❰/❱', '❰/❱'].map((equiv, id) =>
    makeTagNode(`❮ph equiv-text="${equiv}" id="${id}"/❯`, `<span data-chip="${id}"></span>`)
  );
  const sourceTags = collectGientTransSourceTags(sourceWithTagNodes(tags));
  const chip = (index: number) => (tags[index] as HTMLElement).outerHTML;
  assert.equal(renderTarget('<Orange>A</><Orange>B</>', sourceTags),
    chip(0) + 'A' + chip(3) + chip(1) + 'B' + chip(2));
});

test('GientTrans copies bracket markers from the current source row by exact equiv-text', () => {
  const melee = '[InputKey:MeleeAttack]';
  const other = '[NewAction]';
  const ids = [melee, other, melee].map((token, id) =>
    makeTagNode(`❮ph equiv-text="${token}" id="${id}"/❯`,
      `<span class="tagspan"><input type="tag" data-id="${id}"></span>`)
  );
  const tags = collectGientTransSourceTags(sourceWithTagNodes(ids));
  const html = (id: number) => (ids[id] as HTMLElement).outerHTML;
  const target = '通常攻撃[InputKey:MeleeAttack]を長押しして溜める。';
  assert.equal(renderTarget(target, tags), `通常攻撃${html(0)}を長押しして溜める。`);
  assert.equal(renderTarget(target, tagsByToken([])), target);
  assert.equal(
    renderTarget(other + melee + '[InputKey:Jump]' + melee, tags),
    html(1) + html(0) + '[InputKey:Jump]' + html(2)
  );
});

test('GientTrans fills arbitrary literal equiv-text using longest matches and source-order IDs', () => {
  const rows = ['@act', '@act++', '⟦X.*$&amp;{0}⟧', '@act', '❰@future!❱', ''];
  const tags = rows.map((equiv, id) => makeTagNode(
    `❮ph id="${id}" equiv-text="${equiv}"/❯`, `<span data-chip="${id}"></span>`
  ));
  const sourceTags = collectGientTransSourceTags(sourceWithTagNodes(tags));
  const html = renderTarget(
    '@act++@act⟦X.*$&{0}⟧@act<@future!>@ACT', sourceTags
  );
  const chip = (index: number) => (tags[index] as HTMLElement).outerHTML;
  assert.equal(html, chip(1) + chip(0) + chip(2) + chip(3) + chip(4) + '@ACT');
});

test('direct equiv-text is matchable but a marker display number is not', () => {
  const inputs = ['+仮+', ''].map((equiv, index) => ({
    closest: () => null,
    outerHTML: '<input type="tag" value="1">',
    getAttribute: (name: string) => ({ 'equiv-text': equiv, value: String(index + 1) })[name]
  }));
  const source = { querySelectorAll: () => inputs } as unknown as HTMLElement;
  const sourceTags = collectGientTransSourceTags(source);
  assert.equal(renderTarget('12+仮+', sourceTags), '12' + inputs[0].outerHTML);
});

test('target preparation removes only whitespace before real line breaks', () => {
  assert.equal(
    prepareGientTransTarget('Lance \r\n  Dracopousse\t\nFin\\nTag').text,
    'Lance\n  Dracopousse\nFin\\nTag'
  );
  const tags = tagsByToken([['@@ \n@@', ['[chip]']]]);
  const prepared = prepareGientTransTarget('A \n@@ \n@@', tags);
  assert.equal(prepared.text, 'A\n@@ \n@@');
  assert.equal(prepared.html, 'A<span class="whitechar lf" contenteditable="false">\n</span>\u200B[chip]');
});

test('the source lookup reads equiv-text from ph wrappers', () => {
  const tokenOf = (identity: string) =>
    [...collectGientTransSourceTags(sourceWithTagNodes([makeTagNode(identity)])).byToken.keys()][0];
  assert.equal(
    tokenOf(`❮ph note='use equiv-text="example"' data-equiv-text="preview" equiv-text="actual"/❯`),
    'actual'
  );
  assert.equal(
    tokenOf('❮ph equiv-text="❰input key="HardLock"❱" id="2"/❯'),
    '❮input key="HardLock"❯'
  );
  assert.equal(
    tokenOf('❮ph equiv-text="{0}" id="86"/❯'),
    '{0}'
  );
  assert.equal(
    tokenOf(
      '❮ph equiv-text="❰color=#FFA500❱" id="148"/❯'
    ),
    '❮color=#FFA500❯'
  );
  assert.equal(
    tokenOf(
      '❮ph equiv-text="❰/color❱" id="149"/❯'
    ),
    '❮/color❯'
  );
  assert.equal(
    tokenOf(
      '❮ph equiv-text="&lt;link=9&gt;" id="87"/❯'
    ),
    '❮link=9❯'
  );
});

test('renderTarget escapes text and preserves visible spaces', () => {
  assert.equal(
    renderTarget('A <tag> & B'),
    'A<span class="whitechar sp" contenteditable="false"> </span>\u200B&lt;tag&gt;<span class="whitechar sp" contenteditable="false"> </span>\u200B&amp;<span class="whitechar sp" contenteditable="false"> </span>\u200BB'
  );
});

test('GientTrans handles named and self-closing game tags and quoted angle brackets', () => {
  const value = `2<3:<ui:hint label='A > B' id="7"><icon name="lock"/></ui:hint>`;
  assert.equal(renderTarget(value, tagsByToken([
    [`❮ui:hint label='A > B' id="7"❯`, ['[open]']],
    ['❮icon name="lock"/❯', ['[icon]']],
    ['❮/ui:hint❯', ['[close]']]
  ])), '2&lt;3:[open][icon][close]');
});

test('renderTarget preserves non-breaking spaces distinctly', () => {
  assert.equal(
    renderTarget('A\u00A0B'),
    'A<span class="whitechar nbsp" contenteditable="false">\u00A0</span>\u2060B'
  );
});

test('renderTarget converts default GientTrans tag tokens to tag HTML', () => {
  const tagHtml = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮size=38❯"></span>';
  const html = renderTarget(
    '❮size=38❯Cabichou',
    tagsByToken([['❮size=38❯', [tagHtml]]])
  );

  assert.equal(html, `${tagHtml}Cabichou`);
});

test('renderTarget converts XML-like GientTrans tags to tag HTML', () => {
  const openSize = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮size=38❯"></span>';
  const openColor = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮color=#C8712F❯"></span>';
  const closeColor = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/color❯"></span>';
  const closeSize = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/size❯"></span>';
  const html = renderTarget(
    '<size=38><color=#C8712F>Cabichou</color></size>',
    tagsByToken([
      ['❮size=38❯', [openSize]],
      ['❮color=#C8712F❯', [openColor]],
      ['❮/color❯', [closeColor]],
      ['❮/size❯', [closeSize]]
    ])
  );

  assert.equal(html, `${openSize}${openColor}Cabichou${closeColor}${closeSize}`);
});

test('renderTarget preserves distinct IDs for repeated ph tags', () => {
  const firstOpen = '<span data-id="148">open-1</span>';
  const firstClose = '<span data-id="149">close-1</span>';
  const secondOpen = '<span data-id="150">open-2</span>';
  const secondClose = '<span data-id="151">close-2</span>';
  const html = renderTarget(
    '<color=#FFA500>Rosépaon</color> puis <color=#FFA500>Licornel</color>',
    tagsByToken([
      ['❮color=#FFA500❯', [firstOpen, secondOpen]],
      ['❮/color❯', [firstClose, secondClose]]
    ])
  );

  assert.equal(
    html,
    `${firstOpen}Rosépaon${firstClose}<span class="whitechar sp" contenteditable="false"> </span>\u200Bpuis<span class="whitechar sp" contenteditable="false"> </span>\u200B${secondOpen}Licornel${secondClose}`
  );
});

test('renderTarget converts generic XML-like closing tags to tag HTML', () => {
  const openLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮link=8❯"></span>';
  const closeLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/link❯"></span>';
  const html = renderTarget(
    '<link=8>Cabichou</link>',
    tagsByToken([
      ['❮link=8❯', [openLink]],
      ['❮/link❯', [closeLink]]
    ])
  );

  assert.equal(html, `${openLink}Cabichou${closeLink}`);
});

test('renderTarget can use raw generic XML-like closing tag HTML', () => {
  const closeLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="</link>"></span>';
  const html = renderTarget(
    'Cabichou</link>',
    tagsByToken([['</link>', [closeLink]]])
  );

  assert.equal(html, `Cabichou${closeLink}`);
});

test('renderTarget converts numeric brace GientTrans tags to tag HTML', () => {
  const firstTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="{0}"></span>';
  const secondTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="{1}"></span>';
  const html = renderTarget(
    '{0}Cabichou{1}',
    tagsByToken([
      ['{0}', [firstTag]],
      ['{1}', [secondTag]]
    ])
  );

  assert.equal(html, `${firstTag}Cabichou${secondTag}`);
});

test('renderTarget converts literal backslash-n to the matching GientTrans tag', () => {
  const newlineTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="\\n"></span>';

  assert.equal(
    renderTarget(
      'A\\nB',
      tagsByToken([['\\n', [newlineTag]]])
    ),
    `A${newlineTag}B`
  );
});

test('line cleanup preserves a mapped chip ending in whitespace and can reveal a multiline spelling', () => {
  const tags = tagsByToken([['@action ', ['[action]']], ['X\nY', ['[multiline]']]]);
  const prepared = prepareGientTransTarget('@action \nX \r\nY', tags);
  assert.equal(prepared.text, '@action \nX\nY');
  assert.equal(prepared.html, '[action]<span class="whitechar lf" contenteditable="false">\n</span>\u200B[multiline]');
});
