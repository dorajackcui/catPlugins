export function makeTextNode(text: string): ChildNode {
  return {
    nodeType: 3,
    textContent: text
  } as unknown as ChildNode;
}

export function makeTagNode(token: string, html?: string, tid?: string): ChildNode {
  const input = {
    value: token,
    closest: () => node,
    getAttribute(name: string): string | null {
      if (name === 'tid') return tid ?? null;
      return ['tfull', 'title', 'value'].includes(name) ? token : null;
    }
  };

  const escaped = token.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const node = {
    nodeType: 1,
    textContent: '',
    outerHTML: html ?? `<span class="tagspan" contenteditable="false"><input type="tag" value="${escaped}"></span>`,
    className: 'tag_alone tagspan',
    querySelector(selector: string) {
      return selector.includes('input') ? input : null;
    }
  } as unknown as ChildNode;
  return node;
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

export function installGientTransPasteEvents(): () => void {
  const previousInputEvent = globalThis.InputEvent;
  const previousDataTransfer = globalThis.DataTransfer;
  globalThis.InputEvent = FakeInputEvent as never;
  globalThis.DataTransfer = FakeDataTransfer as never;
  return () => {
    globalThis.InputEvent = previousInputEvent;
    globalThis.DataTransfer = previousDataTransfer;
  };
}
