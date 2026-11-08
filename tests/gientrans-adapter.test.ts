import assert from 'node:assert/strict';
import test from 'node:test';

import type { ScrollContext } from '../content/dom.ts';
import { GientTransAdapter } from '../platforms/gientrans/adapter.ts';
import {
  collectGientTransTagHtmlByToken,
  gientransTextToEditorHtml,
  normalizeGientTransEditorText,
  prepareGientTransTargetText
} from '../platforms/gientrans/editor-text.ts';
import { normalizeGientTransDomTagToken } from '../domain/gientrans-markup.ts';

const ROW_SELECTOR = '.editor__table tbody > tr.el-table__row';
const TARGET_SELECTOR = 'td.target-cell pre.edit__input[editortype="target"]';

class FakeEditor {
  className = 'edit__input';
  events: string[] = [];
  private html = '';

  constructor(
    private readonly attributes: Record<string, string>,
    public textContent: string
  ) {
    this.html = textContent;
  }

  get innerText(): string {
    return this.textContent;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.textContent = decodeEditorHtml(value);
  }

  get isContentEditable(): boolean {
    return this.attributes.contenteditable === 'true';
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  matches(selector: string): boolean {
    if (selector !== TARGET_SELECTOR && selector !== 'pre.edit__input[editortype="target"]') {
      return false;
    }

    return this.attributes.editortype === 'target';
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): never[] {
    return [];
  }

  closest(): null {
    return null;
  }

  focus(): void {
    this.events.push('focus');
  }

  dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return true;
  }

  getBoundingClientRect(): DOMRect {
    return {
      top: 20,
      left: 20,
      bottom: 40,
      right: 220,
      width: 200,
      height: 20,
      x: 20,
      y: 20,
      toJSON: () => ({})
    };
  }
}

class FakeRow {
  id = '';
  className = 'el-table__row draft';

  constructor(
    readonly rowNumber: string,
    readonly source: FakeEditor,
    readonly target: FakeEditor
  ) {}

  querySelector<T extends Element = Element>(selector: string): T | null {
    if (selector.includes('source-cell')) {
      return this.source as unknown as T;
    }

    if (selector.includes('target-cell')) {
      return this.target as unknown as T;
    }

    if (selector === '.sort-index') {
      return { textContent: this.rowNumber, innerText: this.rowNumber } as unknown as T;
    }

    return null;
  }

  getAttribute(): null {
    return null;
  }

  getBoundingClientRect(): DOMRect {
    return {
      top: Number(this.rowNumber) * 20,
      left: 0,
      bottom: Number(this.rowNumber) * 20 + 20,
      right: 600,
      width: 600,
      height: 20,
      x: 0,
      y: Number(this.rowNumber) * 20,
      toJSON: () => ({})
    };
  }
}

function makeEditor(editortype: 'source' | 'target', segid: string, text: string): FakeEditor {
  return new FakeEditor(
    {
      class: 'edit__input',
      contenteditable: editortype === 'target' ? 'true' : 'false',
      editortype,
      segid
    },
    text
  );
}

function fakeScrollContext(): ScrollContext {
  return {
    initialTop: 0,
    getTop: () => 0,
    getHeight: () => 500,
    scrollBy: () => undefined,
    scrollToTop: () => undefined,
    isAtBottom: () => true,
    restore: () => undefined
  };
}

function createHelpers(calls: string[] = []) {
  return {
    sortByVisualPosition: <T extends Element>(elements: T[]) => elements,
    isElementVisible: () => true,
    getAbsoluteTop: () => 120,
    findBestScrollContainer: () => null,
    toElementScrollContext: () => fakeScrollContext(),
    dispatchMouseSequence: (_target: HTMLElement, eventNames: string[]) => {
      calls.push(...eventNames.map((eventName) => `mouse:${eventName}`));
    },
    dispatchInput: (target: EventTarget) => {
      calls.push('input');
      target.dispatchEvent(new Event('input'));
    },
    dispatchChange: (target: EventTarget) => {
      calls.push('change');
      target.dispatchEvent(new Event('change'));
    },
    dispatchBlur: (target: EventTarget) => {
      calls.push('blur');
      target.dispatchEvent(new Event('blur'));
    }
  } as never;
}

function installFakeDocument(rows: FakeRow[]): () => void {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;

  globalThis.document = {
    body: {},
    querySelector: () => null,
    querySelectorAll: (selector: string) => {
      if (selector === ROW_SELECTOR) {
        return rows;
      }

      if (selector === TARGET_SELECTOR) {
        return rows.map((row) => row.target);
      }

      return [];
    }
  } as unknown as Document;

  globalThis.window = {
    setTimeout
  } as unknown as Window & typeof globalThis;

  return () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
}

function silenceConsoleInfo(): () => void {
  const previousInfo = console.info;
  console.info = (() => undefined) as never;
  return () => {
    console.info = previousInfo;
  };
}

function decodeEditorHtml(value: string): string {
  return value
    .replace(/<span\b[^>]*class="whitechar sp"[^>]*> <\/span>\u200B/g, ' ')
    .replace(/<span\b[^>]*class="whitechar nbsp"[^>]*>\u00A0<\/span>\u2060/g, '\u00A0')
    .replace(/<span\b[^>]*class="whitechar lf"[^>]*>\n<\/span>\u200B/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

class FakeDataTransfer {
  private readonly data = new Map<string, string>();

  setData(type: string, value: string): void {
    this.data.set(type, value);
  }

  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
}

class FakeInputEvent extends Event {
  readonly data: string | null;
  readonly inputType: string;

  constructor(type: string, init?: InputEventInit) {
    super(type, init);
    this.data = init?.data ?? null;
    this.inputType = init?.inputType ?? '';
  }
}

function makeTextNode(text: string): ChildNode {
  return {
    nodeType: 3,
    textContent: text
  } as unknown as ChildNode;
}

function makeTagNode(token: string, html = `<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" class="_alone tag" tfull="${token}" title="${token}" value="${token}"></span>`): ChildNode {
  const input = {
    value: token,
    closest: () => node,
    getAttribute(name: string): string | null {
      return ['tfull', 'title', 'value'].includes(name) ? token : null;
    }
  };

  const node = {
    nodeType: 1,
    textContent: '',
    outerHTML: html,
    className: 'tag_alone tagspan',
    querySelector(selector: string) {
      return selector.includes('input') ? input : null;
    }
  } as unknown as ChildNode;
  return node;
}

function sourceWithTagNodes(nodes: ChildNode[]): HTMLElement {
  return {
    querySelectorAll: () => nodes.map(node => (node as HTMLElement).querySelector('input'))
  } as unknown as HTMLElement;
}

function setChildNodes(editor: FakeEditor, childNodes: ChildNode[]): void {
  Object.defineProperty(editor, 'childNodes', {
    configurable: true,
    value: childNodes
  });
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
  const { tagHtmlByToken, pairedClosers } = collectGientTransTagHtmlByToken(source);
  const html = gientransTextToEditorHtml(
    '<input key="Jump"></><Orange>S1シーズン（前半）</><input key="HardLock"></>を押す。<br>',
    tagHtmlByToken, pairedClosers
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

test('nested identical opening chips keep their own closing IDs when translated as siblings', () => {
  const tags = ['❰Orange❱', '❰Orange❱', '❰/❱', '❰/❱'].map((equiv, id) =>
    makeTagNode(`❮ph equiv-text="${equiv}" id="${id}"/❯`, `<span data-chip="${id}"></span>`)
  );
  const { tagHtmlByToken, pairedClosers } = collectGientTransTagHtmlByToken(sourceWithTagNodes(tags));
  const chip = (index: number) => (tags[index] as HTMLElement).outerHTML;
  assert.equal(gientransTextToEditorHtml('<Orange>A</><Orange>B</>', tagHtmlByToken, pairedClosers),
    chip(0) + 'A' + chip(3) + chip(1) + 'B' + chip(2));
});

test('GientTrans copies bracket markers from the current source row by exact equiv-text', () => {
  const melee = '[InputKey:MeleeAttack]';
  const other = '[NewAction]';
  const ids = [melee, other, melee].map((token, id) =>
    makeTagNode(`❮ph equiv-text="${token}" id="${id}"/❯`,
      `<span class="tagspan"><input type="tag" data-id="${id}"></span>`)
  );
  const { tagHtmlByToken: tags } = collectGientTransTagHtmlByToken(sourceWithTagNodes(ids));
  const html = (id: number) => (ids[id] as HTMLElement).outerHTML;
  const target = '通常攻撃[InputKey:MeleeAttack]を長押しして溜める。';
  assert.equal(gientransTextToEditorHtml(target, tags), `通常攻撃${html(0)}を長押しして溜める。`);
  assert.equal(gientransTextToEditorHtml(target, new Map()), target);
  assert.equal(
    gientransTextToEditorHtml(other + melee + '[InputKey:Jump]' + melee, tags),
    html(1) + html(0) + '[InputKey:Jump]' + html(2)
  );
});

test('GientTrans fills arbitrary literal equiv-text using longest matches and source-order IDs', () => {
  const rows = ['@act', '@act++', '⟦X.*$&amp;{0}⟧', '@act', '❰@future!❱', ''];
  const tags = rows.map((equiv, id) => makeTagNode(
    `❮ph id="${id}" equiv-text="${equiv}"/❯`, `<span data-chip="${id}"></span>`
  ));
  const { tagHtmlByToken, pairedClosers } = collectGientTransTagHtmlByToken(sourceWithTagNodes(tags));
  const html = gientransTextToEditorHtml(
    '@act++@act⟦X.*$&{0}⟧@act<@future!>@ACT', tagHtmlByToken, pairedClosers
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
  const { tagHtmlByToken } = collectGientTransTagHtmlByToken(source);
  assert.equal(gientransTextToEditorHtml('12+仮+', tagHtmlByToken), '12' + inputs[0].outerHTML);
});

test('prepareGientTransTargetText removes only whitespace before real line breaks', () => {
  assert.equal(
    prepareGientTransTargetText('Lance \r\n  Dracopousse\t\nFin\\nTag'),
    'Lance\n  Dracopousse\nFin\\nTag'
  );
  assert.equal(prepareGientTransTargetText('A \n@@ \n@@', ['@@ \n@@']), 'A\n@@ \n@@');
});

test('normalizeGientTransDomTagToken unwraps new ph equiv-text tags', () => {
  assert.equal(
    normalizeGientTransDomTagToken(`❮ph note='use equiv-text="example"' data-equiv-text="preview" equiv-text="actual"/❯`),
    'actual'
  );
  assert.equal(
    normalizeGientTransDomTagToken('❮ph equiv-text="❰input key="HardLock"❱" id="2"/❯'),
    '❮input key="HardLock"❯'
  );
  assert.equal(
    normalizeGientTransDomTagToken('❮ph equiv-text="{0}" id="86"/❯'),
    '{0}'
  );
  assert.equal(
    normalizeGientTransDomTagToken(
      '❮ph equiv-text="❰color=#FFA500❱" id="148"/❯'
    ),
    '❮color=#FFA500❯'
  );
  assert.equal(
    normalizeGientTransDomTagToken(
      '❮ph equiv-text="❰/color❱" id="149"/❯'
    ),
    '❮/color❯'
  );
  assert.equal(
    normalizeGientTransDomTagToken(
      '❮ph equiv-text="&lt;link=9&gt;" id="87"/❯'
    ),
    '❮link=9❯'
  );
});

test('gientransTextToEditorHtml escapes text and preserves visible spaces', () => {
  assert.equal(
    gientransTextToEditorHtml('A <tag> & B'),
    'A<span class="whitechar sp" contenteditable="false"> </span>\u200B&lt;tag&gt;<span class="whitechar sp" contenteditable="false"> </span>\u200B&amp;<span class="whitechar sp" contenteditable="false"> </span>\u200BB'
  );
});

test('GientTrans handles named and self-closing game tags and quoted angle brackets', () => {
  const value = `2<3:<ui:hint label='A > B' id="7"><icon name="lock"/></ui:hint>`;
  assert.equal(gientransTextToEditorHtml(value, new Map([
    [`❮ui:hint label='A > B' id="7"❯`, ['[open]']],
    ['❮icon name="lock"/❯', ['[icon]']],
    ['❮/ui:hint❯', ['[close]']]
  ])), '2&lt;3:[open][icon][close]');
});

test('gientransTextToEditorHtml preserves non-breaking spaces distinctly', () => {
  assert.equal(
    gientransTextToEditorHtml('A\u00A0B'),
    'A<span class="whitechar nbsp" contenteditable="false">\u00A0</span>\u2060B'
  );
});

test('gientransTextToEditorHtml converts default GientTrans tag tokens to tag HTML', () => {
  const tagHtml = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮size=38❯"></span>';
  const html = gientransTextToEditorHtml(
    '❮size=38❯Cabichou',
    new Map([['❮size=38❯', [tagHtml]]])
  );

  assert.equal(html, `${tagHtml}Cabichou`);
});

test('gientransTextToEditorHtml converts XML-like GientTrans tags to tag HTML', () => {
  const openSize = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮size=38❯"></span>';
  const openColor = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮color=#C8712F❯"></span>';
  const closeColor = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/color❯"></span>';
  const closeSize = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/size❯"></span>';
  const html = gientransTextToEditorHtml(
    '<size=38><color=#C8712F>Cabichou</color></size>',
    new Map([
      ['❮size=38❯', [openSize]],
      ['❮color=#C8712F❯', [openColor]],
      ['❮/color❯', [closeColor]],
      ['❮/size❯', [closeSize]]
    ])
  );

  assert.equal(html, `${openSize}${openColor}Cabichou${closeColor}${closeSize}`);
});

test('gientransTextToEditorHtml preserves distinct IDs for repeated ph tags', () => {
  const firstOpen = '<span data-id="148">open-1</span>';
  const firstClose = '<span data-id="149">close-1</span>';
  const secondOpen = '<span data-id="150">open-2</span>';
  const secondClose = '<span data-id="151">close-2</span>';
  const html = gientransTextToEditorHtml(
    '<color=#FFA500>Rosépaon</color> puis <color=#FFA500>Licornel</color>',
    new Map([
      ['❮color=#FFA500❯', [firstOpen, secondOpen]],
      ['❮/color❯', [firstClose, secondClose]]
    ])
  );

  assert.equal(
    html,
    `${firstOpen}Rosépaon${firstClose}<span class="whitechar sp" contenteditable="false"> </span>\u200Bpuis<span class="whitechar sp" contenteditable="false"> </span>\u200B${secondOpen}Licornel${secondClose}`
  );
});

test('GientTransAdapter serializes new ph wrappers as their source tokens', () => {
  const source = makeEditor('source', 'target-ph', '');
  setChildNodes(source, [
    makeTagNode('❮ph equiv-text="{0}" id="86"/❯'),
    makeTagNode('❮ph equiv-text="❰link=9❱" id="87"/❯'),
    makeTextNode('防御'),
    makeTagNode('❮ph equiv-text="❰/link❱" id="90"/❯')
  ]);
  const row = new FakeRow(
    '6',
    source,
    makeEditor('target', 'target-ph', '')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers());
    const segments = adapter.collectVisibleSegments(fakeScrollContext());

    assert.equal(segments[0]?.sourceRaw, '{0}❮link=9❯防御❮/link❯');
    assert.deepEqual(segments[0]?.placeholderTokens, [
      '{0}',
      '❮link=9❯',
      '❮/link❯'
    ]);
  } finally {
    restoreConsole();
    restore();
  }
});

test('gientransTextToEditorHtml converts generic XML-like closing tags to tag HTML', () => {
  const openLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮link=8❯"></span>';
  const closeLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="❮/link❯"></span>';
  const html = gientransTextToEditorHtml(
    '<link=8>Cabichou</link>',
    new Map([
      ['❮link=8❯', [openLink]],
      ['❮/link❯', [closeLink]]
    ])
  );

  assert.equal(html, `${openLink}Cabichou${closeLink}`);
});

test('gientransTextToEditorHtml can use raw generic XML-like closing tag HTML', () => {
  const closeLink = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="</link>"></span>';
  const html = gientransTextToEditorHtml(
    'Cabichou</link>',
    new Map([['</link>', [closeLink]]])
  );

  assert.equal(html, `Cabichou${closeLink}`);
});

test('gientransTextToEditorHtml converts numeric brace GientTrans tags to tag HTML', () => {
  const firstTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="{0}"></span>';
  const secondTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="{1}"></span>';
  const html = gientransTextToEditorHtml(
    '{0}Cabichou{1}',
    new Map([
      ['{0}', [firstTag]],
      ['{1}', [secondTag]]
    ])
  );

  assert.equal(html, `${firstTag}Cabichou${secondTag}`);
});

test('gientransTextToEditorHtml converts literal backslash-n to the matching GientTrans tag', () => {
  const newlineTag = '<span class="tag_alone tagspan" contenteditable="false"><input readonly="" type="tag" value="\\n"></span>';

  assert.equal(
    gientransTextToEditorHtml(
      'A\\nB',
      new Map([['\\n', [newlineTag]]])
    ),
    `A${newlineTag}B`
  );
});

test('GientTransAdapter.collectVisibleSegments extracts rows and keeps existing target content', () => {
  const row = new FakeRow(
    '2',
    makeEditor('source', 'target-2', 'Le Cocoricou'),
    makeEditor('target', 'target-2', 'Le<span ignored> </span>\u200BCocoricou')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers());
    const segments = adapter.collectVisibleSegments(fakeScrollContext());

    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.platform, 'gientrans');
    assert.equal(segments[0]?.domId, 'target-2');
    assert.equal(segments[0]?.rowNumber, '2');
    assert.equal(segments[0]?.sourceRaw, 'Le Cocoricou');
    assert.equal(segments[0]?.targetRaw, 'Le<span ignored> </span>Cocoricou');
    assert.equal(segments[0]?.isEmptyTarget, false);
  } finally {
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.collectVisibleSegments serializes default source tag tokens', () => {
  const source = makeEditor('source', 'target-2', 'Cabichou New');
  setChildNodes(source, [
    makeTagNode('❮size=38❯'),
    makeTagNode('❮color=#C8712F❯'),
    makeTextNode('卡皮巴拉'),
    makeTagNode('❮/color❯'),
    makeTagNode('❮/size❯'),
    makeTextNode(' New')
  ]);
  const row = new FakeRow(
    '2',
    source,
    makeEditor('target', 'target-2', '')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers());
    const segments = adapter.collectVisibleSegments(fakeScrollContext());

    assert.equal(
      segments[0]?.sourceRaw,
      '❮size=38❯❮color=#C8712F❯卡皮巴拉❮/color❯❮/size❯ New'
    );
    assert.equal(
      segments[0]?.sourceNormalized,
      '❮size=38❯❮color=#C8712F❯卡皮巴拉❮/color❯❮/size❯ New'
    );
    assert.deepEqual(segments[0]?.placeholderTokens, [
      '❮size=38❯',
      '❮color=#C8712F❯',
      '❮/color❯',
      '❮/size❯'
    ]);
  } finally {
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.collectVisibleSegments keeps default newline tags as tag tokens', () => {
  const source = makeEditor('source', 'target-2', 'A B');
  setChildNodes(source, [
    makeTextNode('A'),
    makeTagNode('\\n'),
    makeTextNode('B')
  ]);
  const row = new FakeRow(
    '2',
    source,
    makeEditor('target', 'target-2', '')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers());
    const segments = adapter.collectVisibleSegments(fakeScrollContext());

    assert.equal(segments[0]?.sourceRaw, 'A\\nB');
    assert.equal(segments[0]?.sourceNormalized, 'A\\nB');
    assert.deepEqual(segments[0]?.placeholderTokens, ['\\n']);
  } finally {
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment replaces a target that already has content', async () => {
  const row = new FakeRow(
    '3',
    makeEditor('source', 'target-3', 'Hello'),
    makeEditor('target', 'target-3', 'Existing target')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers());
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-3',
        rowNumber: '3',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Bonjour'
    );

    assert.equal(outcome.filled, true);
    assert.equal(row.target.textContent, 'Bonjour');
    assert.equal(/Existing target/.test(row.target.innerHTML), false);
  } finally {
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment writes an empty target through the editor element', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '4',
    makeEditor('source', 'target-4', 'Hello'),
    makeEditor('target', 'target-4', '')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-4',
        rowNumber: '4',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Bonjour le monde'
    );

    assert.equal(outcome.filled, true);
    assert.equal(adapter.getEditableValue(row.target as never), 'Bonjour le monde');
    assert.equal(/whitechar sp/.test(row.target.innerHTML), true);
    assert.deepEqual(calls.slice(-3), ['input', 'change', 'blur']);
  } finally {
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment prefers the native insertText editing path', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '5',
    makeEditor('source', 'target-5', 'Hello'),
    makeEditor('target', 'target-5', '')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();
  const previousExecCommand = globalThis.document.execCommand;

  globalThis.document.execCommand = ((command: string, _showDefaultUi?: boolean, value?: string) => {
    calls.push(`execCommand:${command}`);
    if (command !== 'insertText') {
      return false;
    }

    row.target.textContent = value ?? '';
    row.target.innerHTML = value ?? '';
    row.target.dispatchEvent(new InputEvent('input', { bubbles: true, data: value ?? '' }));
    return true;
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-5',
        rowNumber: '5',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Bonjour'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.includes('execCommand:insertText'), true);
    assert.equal(adapter.getEditableValue(row.target as never), 'Bonjour');
  } finally {
    globalThis.document.execCommand = previousExecCommand;
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment uses GientTrans beforeinput paste when available', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '6',
    makeEditor('source', 'target-6', 'Hello'),
    makeEditor('target', 'target-6', 'Old target')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();
  const previousInputEvent = globalThis.InputEvent;
  const previousDataTransfer = globalThis.DataTransfer;
  const previousExecCommand = globalThis.document.execCommand;
  const originalDispatchEvent = row.target.dispatchEvent.bind(row.target);

  globalThis.InputEvent = FakeInputEvent as never;
  globalThis.DataTransfer = FakeDataTransfer as never;
  globalThis.document.execCommand = ((command: string) => {
    calls.push(`execCommand:${command}`);
    return false;
  }) as never;
  row.target.dispatchEvent = ((event: Event) => {
    if (event.type === 'beforeinput') {
      const inputEvent = event as InputEvent & { dataTransfer?: DataTransfer };
      calls.push(`beforeinput:${inputEvent.inputType}:${inputEvent.dataTransfer?.getData('text/plain') ?? ''}`);
      row.target.innerHTML = inputEvent.dataTransfer?.getData('text/segment') ?? '';
      event.preventDefault();
      return false;
    }

    return originalDispatchEvent(event);
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-6',
        rowNumber: '6',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: 'Old target',
        isEmptyTarget: false,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'A\u00A0B'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('beforeinput:')),
      ['beforeinput:insertFromPaste:A\u00A0B']
    );
    assert.equal(calls.some((call) => call.startsWith('execCommand:')), false);
    assert.equal(row.target.innerHTML.includes('whitechar nbsp'), true);
    assert.equal(row.target.innerHTML.includes('Old target'), false);
  } finally {
    globalThis.InputEvent = previousInputEvent;
    globalThis.DataTransfer = previousDataTransfer;
    globalThis.document.execCommand = previousExecCommand;
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment removes trailing line whitespace before writing', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '6',
    makeEditor('source', 'target-6', '兰斯 \n草龙宝宝'),
    makeEditor('target', 'target-6', 'Old target')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();
  const previousInputEvent = globalThis.InputEvent;
  const previousDataTransfer = globalThis.DataTransfer;
  const originalDispatchEvent = row.target.dispatchEvent.bind(row.target);

  globalThis.InputEvent = FakeInputEvent as never;
  globalThis.DataTransfer = FakeDataTransfer as never;
  row.target.dispatchEvent = ((event: Event) => {
    if (event.type === 'beforeinput') {
      const inputEvent = event as InputEvent & { dataTransfer?: DataTransfer };
      calls.push(
        `beforeinput:${inputEvent.dataTransfer?.getData('text/plain') ?? ''}`
      );
      row.target.innerHTML =
        inputEvent.dataTransfer?.getData('text/segment') ?? '';
      event.preventDefault();
      return false;
    }

    return originalDispatchEvent(event);
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-6',
        rowNumber: '6',
        sourceRaw: '兰斯 \n草龙宝宝',
        sourceNormalized: '兰斯 草龙宝宝',
        occurrenceIndex: 1,
        targetRaw: 'Old target',
        isEmptyTarget: false,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Lance \r\nDracopousse'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('beforeinput:')),
      ['beforeinput:Lance\nDracopousse']
    );
    assert.equal(
      adapter.getEditableValue(row.target as never),
      'Lance\nDracopousse'
    );
    assert.equal(row.target.innerHTML.includes('whitechar lf'), true);
    assert.equal(row.target.innerHTML.includes('whitechar sp'), false);
  } finally {
    globalThis.InputEvent = previousInputEvent;
    globalThis.DataTransfer = previousDataTransfer;
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment uses encoded HTML when translation contains NBSP', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '6',
    makeEditor('source', 'target-6', 'Hello'),
    makeEditor('target', 'target-6', 'Old target')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();
  const previousExecCommand = globalThis.document.execCommand;

  globalThis.document.execCommand = ((command: string, _showDefaultUi?: boolean, value?: string) => {
    calls.push(`execCommand:${command}:${value ?? ''}`);
    row.target.textContent = (value ?? '').replace(/\u00A0/g, ' ');
    row.target.innerHTML = row.target.textContent;
    return true;
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-6',
        rowNumber: '6',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: 'Old target',
        isEmptyTarget: false,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'A\u00A0B'
    );

    assert.equal(outcome.filled, true);
    assert.equal(calls.some((call) => call.startsWith('execCommand:insertText')), false);
    assert.equal(row.target.innerHTML.includes('whitechar nbsp'), true);
    assert.equal(row.target.innerHTML.includes('Old target'), false);
  } finally {
    globalThis.document.execCommand = previousExecCommand;
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment falls back to native insertHTML when insertText does not write', async () => {
  const calls: string[] = [];
  const row = new FakeRow(
    '7',
    makeEditor('source', 'target-7', '彩色：'),
    makeEditor('target', 'target-7', 'Arc-en-ciel :')
  );
  const restore = installFakeDocument([row]);
  const restoreConsole = silenceConsoleInfo();
  const previousExecCommand = globalThis.document.execCommand;

  globalThis.document.execCommand = ((command: string, _showDefaultUi?: boolean, value?: string) => {
    calls.push(`execCommand:${command}`);
    if (command === 'insertText') {
      return false;
    }

    if (command === 'insertHTML') {
      row.target.innerHTML = value ?? '';
      return true;
    }

    return false;
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers(calls));
    const outcome = await adapter.fillSegment(
      {
        domId: 'target-7',
        rowNumber: '7',
        sourceRaw: '彩色：',
        sourceNormalized: '彩色：',
        occurrenceIndex: 1,
        targetRaw: 'Arc-en-ciel :',
        isEmptyTarget: false,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Irisé :'
    );

    assert.equal(outcome.filled, true);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('execCommand:')),
      ['execCommand:insertText', 'execCommand:insertHTML']
    );
    assert.equal(adapter.getEditableValue(row.target as never), 'Irisé :');
    assert.equal(row.target.innerHTML.includes('whitechar sp'), true);
  } finally {
    globalThis.document.execCommand = previousExecCommand;
    restoreConsole();
    restore();
  }
});

test('GientTransAdapter.fillSegment emits diagnostics for write attempts', async () => {
  const row = new FakeRow(
    '6',
    makeEditor('source', 'target-6', 'Hello'),
    makeEditor('target', 'target-6', '')
  );
  const restore = installFakeDocument([row]);
  const previousInfo = console.info;
  const logs: unknown[][] = [];
  console.info = ((...args: unknown[]) => {
    logs.push(args);
  }) as never;

  try {
    const adapter = new GientTransAdapter(createHelpers());
    await adapter.fillSegment(
      {
        domId: 'target-6',
        rowNumber: '6',
        sourceRaw: 'Hello',
        sourceNormalized: 'Hello',
        occurrenceIndex: 1,
        targetRaw: '',
        isEmptyTarget: true,
        placeholderTokens: [],
        targetElement: row.target as never,
        platform: 'gientrans'
      },
      'Bonjour'
    );

    const labels = logs.map((entry) => entry[1]);
    assert.equal(logs.some((entry) => entry[0] === '[Phrase Bulk Fill][GientTrans]'), true);
    assert.equal(labels.includes('fill:start'), true);
    assert.equal(labels.includes('fill:write'), true);
    assert.equal(labels.includes('fill:complete'), true);
  } finally {
    console.info = previousInfo;
    restore();
  }
});
