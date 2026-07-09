export interface FakeRect {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface FakeElementOptions {
  tagName?: string;
  id?: string;
  className?: string;
  textContent?: string;
  attributes?: Record<string, string>;
  rect?: FakeRect;
  children?: Array<FakeElement | FakeTextNode>;
}

export interface FakeTextNode {
  nodeType: 3;
  textContent: string;
  parentElement?: FakeElement;
}

export interface FakeElement {
  nodeType: 1;
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  innerText: string;
  parentElement: FakeElement | null;
  children: FakeElement[];
  childNodes: Array<FakeElement | FakeTextNode>;
  classList: { contains(className: string): boolean };
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  querySelector<T extends Element = Element>(selector: string): T | null;
  querySelectorAll<T extends Element = Element>(selector: string): T[];
  getBoundingClientRect(): DOMRect;
  scrollIntoView(): void;
}

export function fakeText(textContent: string): FakeTextNode {
  return {
    nodeType: 3,
    textContent
  };
}

export function fakeElement(options: FakeElementOptions = {}): FakeElement {
  const classNames = (options.className ?? '').split(/\s+/).filter(Boolean);

  const element: FakeElement = {
    nodeType: 1,
    tagName: options.tagName ?? 'DIV',
    id: options.id ?? '',
    className: options.className ?? '',
    textContent: options.textContent ?? '',
    innerText: options.textContent ?? '',
    parentElement: null,
    children: [],
    childNodes: [],
    classList: {
      contains: (className: string) => classNames.includes(className)
    },
    attributes: options.attributes ?? {},
    getAttribute: (name: string) => element.attributes[name] ?? null,
    matches: (selector: string) => matchesSelector(element, selector),
    querySelector: <T extends Element = Element>(selector: string): T | null => {
      const first = querySelectorAll(element, selector)[0];
      return (first as unknown as T | undefined) ?? null;
    },
    querySelectorAll: <T extends Element = Element>(selector: string): T[] =>
      querySelectorAll(element, selector) as unknown as T[],
    getBoundingClientRect: () => {
      const width = options.rect?.width ?? 120;
      const height = options.rect?.height ?? 24;
      const left = options.rect?.left ?? 0;
      const top = options.rect?.top ?? 0;
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height
      } as DOMRect;
    },
    scrollIntoView: () => undefined
  };

  for (const child of options.children ?? []) {
    appendChild(element, child);
  }

  if (element.children.length === 0 && element.textContent) {
    const textNode = fakeText(element.textContent);
    textNode.parentElement = element;
    element.childNodes.push(textNode);
  }

  return element;
}

export function appendChild(parent: FakeElement, child: FakeElement | FakeTextNode): void {
  child.parentElement = parent;
  parent.childNodes.push(child);
  if (child.nodeType === 1) {
    parent.children.push(child);
  }
}

export function fakeDocument(root: FakeElement): Document {
  return {
    body: root,
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector)
  } as unknown as Document;
}

function querySelectorAll(root: FakeElement, selector: string): FakeElement[] {
  const matches: FakeElement[] = [];

  const visit = (element: FakeElement): void => {
    if (element.matches(selector)) {
      matches.push(element);
    }

    for (const child of element.children) {
      visit(child);
    }
  };

  visit(root);
  return matches;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => matchesSingleSelector(element, part));
}

function matchesSingleSelector(element: FakeElement, selector: string): boolean {
  if (!selector) {
    return false;
  }

  if (selector === '*') {
    return true;
  }

  const tagMatch = selector.match(/^[a-z]+/i);
  if (tagMatch && element.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) {
    return false;
  }

  for (const classMatch of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!element.className.split(/\s+/).includes(classMatch[1])) {
      return false;
    }
  }

  for (const attrMatch of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
    const attrName = attrMatch[1];
    const expected = attrMatch[2];
    const actual = element.getAttribute(attrName);
    if (actual === null) {
      return false;
    }
    if (expected !== undefined && actual !== expected) {
      return false;
    }
  }

  return true;
}
