import { normalizeText } from './utils.ts';

export const KNOWN_SCROLL_CONTAINER_SELECTORS = [
  '[data-testid*="virtual"]',
  '[data-testid*="scroll"]',
  '[class*="virtual"]',
  '[class*="scroll"]',
  '[class*="viewport"]',
  '[role="grid"]',
  '[role="table"]'
];

export type EditableElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface ScrollContext {
  initialTop: number;
  mode?: 'native' | 'synthetic';
  getTop(): number;
  getHeight(): number;
  scrollBy(delta: number): void;
  isAtBottom(): boolean;
  restore(): void;
}

export interface RuntimeSegment {
  domId: string;
  sourceRaw: string;
  sourceNormalized: string;
  occurrenceIndex: number;
  targetRaw: string;
  isEmptyTarget: boolean;
  placeholderTokens: string[];
  targetElement: EditableElement;
  platform: 'memoq' | 'phrase' | 'generic';
  scanElement?: Element;
  scanFingerprint?: string;
}

export class ContentScriptDomHelpers {
  sortByVisualPosition<T extends Element>(
    elements: T[],
    scrollContext: ScrollContext,
    topTolerancePx = 2
  ): T[] {
    return [...elements].sort((left, right) => {
      const topDiff =
        this.getAbsoluteTop(left, scrollContext) -
        this.getAbsoluteTop(right, scrollContext);

      if (Math.abs(topDiff) > topTolerancePx) {
        return topDiff;
      }

      return left.getBoundingClientRect().left - right.getBoundingClientRect().left;
    });
  }

  readTextBySelectors(root: ParentNode, selectors: string[]): string {
    for (const selector of selectors) {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) {
        continue;
      }

      const text = normalizeText(node.innerText || node.textContent || '');
      if (text) {
        return text;
      }
    }

    return '';
  }

  isElementVisible(element: Element): boolean {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  getAbsoluteTop(element: Element, scrollContext: ScrollContext): number {
    const rect = element.getBoundingClientRect();
    return scrollContext.getTop() + rect.top;
  }

  toElementScrollContext(container: HTMLElement): ScrollContext {
    const initialTop = container.scrollTop;
    return {
      initialTop,
      mode: 'native',
      getTop: () => container.scrollTop,
      getHeight: () => container.clientHeight || window.innerHeight,
      scrollBy: (delta) => container.scrollBy({ top: delta, behavior: 'auto' }),
      isAtBottom: () =>
        container.scrollTop + container.clientHeight >= container.scrollHeight - 8,
      restore: () => container.scrollTo({ top: initialTop, behavior: 'auto' })
    };
  }

  toWindowScrollContext(): ScrollContext {
    const initialTop = window.scrollY;
    return {
      initialTop,
      mode: 'native',
      getTop: () => window.scrollY,
      getHeight: () => window.innerHeight,
      scrollBy: (delta) => window.scrollBy({ top: delta, behavior: 'auto' }),
      isAtBottom: () =>
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8,
      restore: () => window.scrollTo({ top: initialTop, behavior: 'auto' })
    };
  }

  isScrollableContainer(
    element: HTMLElement,
    requireScrollableOverflow: boolean
  ): boolean {
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const scrollableOverflow =
      overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';

    if (requireScrollableOverflow) {
      return scrollableOverflow && element.scrollHeight > element.clientHeight + 120;
    }

    return element.scrollHeight > element.clientHeight + 120;
  }

  findBestScrollContainer(editables: HTMLElement[]): HTMLElement | null {
    const candidateContainers = new Map<HTMLElement, { score: number; depthBoost: number }>();

    for (const selector of KNOWN_SCROLL_CONTAINER_SELECTORS) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (this.isScrollableContainer(element, true)) {
          candidateContainers.set(element, {
            score: 6,
            depthBoost: element.scrollHeight - element.clientHeight
          });
        }
      }
    }

    for (const editable of editables) {
      let ancestor = editable.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body) {
        if (this.isScrollableContainer(ancestor, false)) {
          const current = candidateContainers.get(ancestor) ?? {
            score: 0,
            depthBoost: ancestor.scrollHeight - ancestor.clientHeight
          };
          current.score += Math.max(1, 6 - depth);
          if (this.isScrollableContainer(ancestor, true)) {
            current.score += 2;
          }
          current.depthBoost = Math.max(
            current.depthBoost,
            ancestor.scrollHeight - ancestor.clientHeight
          );
          candidateContainers.set(ancestor, current);
        }
        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidateContainers.entries()]
      .sort((left, right) => {
        if (right[1].score !== left[1].score) {
          return right[1].score - left[1].score;
        }

        return right[1].depthBoost - left[1].depthBoost;
      })[0]?.[0] ?? null;
  }

  findSegmentContainer(
    targetElement: EditableElement,
    selectors: string[]
  ): HTMLElement {
    for (const selector of selectors) {
      const candidate = targetElement.closest<HTMLElement>(selector);
      if (candidate) {
        return candidate;
      }
    }

    let cursor: HTMLElement | null = targetElement.parentElement;
    let depth = 0;
    while (cursor && depth < 6) {
      if (cursor.textContent && normalizeText(cursor.textContent).length > 0) {
        return cursor;
      }
      cursor = cursor.parentElement;
      depth += 1;
    }

    return document.body;
  }

  findSourceText(
    container: HTMLElement,
    targetElement: EditableElement,
    sourceSelectors: string[]
  ): string {
    for (const selector of sourceSelectors) {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(selector));
      for (const node of nodes) {
        if (node === targetElement || node.contains(targetElement)) {
          continue;
        }

        const text = normalizeText(node.innerText || node.textContent || '');
        if (text) {
          return text;
        }
      }
    }

    const fragments: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();

    while (node) {
      const parent = node.parentElement;
      const textContent = normalizeText(node.textContent ?? '');

      if (
        parent &&
        !targetElement.contains(parent) &&
        !parent.contains(targetElement) &&
        this.isElementVisible(parent) &&
        textContent
      ) {
        fragments.push(textContent);
      }

      node = walker.nextNode();
    }

    return normalizeText(fragments.join(' '));
  }

  isEditableCandidate(element: EditableElement): boolean {
    if (!this.isElementVisible(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }

    return element.isContentEditable;
  }

  getGenericEditableValue(targetElement: EditableElement): string {
    if (targetElement instanceof HTMLInputElement || targetElement instanceof HTMLTextAreaElement) {
      return targetElement.value ?? '';
    }

    return targetElement.textContent ?? '';
  }

  setEditableValue(target: EditableElement, value: string): void {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      this.setNativeInputValue(target, value);
      return;
    }

    target.textContent = value;
  }

  setNativeInputValue(
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void {
    const prototype = Object.getPrototypeOf(input) as HTMLInputElement | HTMLTextAreaElement;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  dispatchInput(target: EventTarget, value: string, includeBeforeInput = false): void {
    if (includeBeforeInput) {
      target.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: 'insertText'
        })
      );
    }

    target.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText'
      })
    );
  }

  dispatchChange(target: EventTarget): void {
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  dispatchBlur(target: EventTarget): void {
    target.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  dispatchTabNavigation(target: EventTarget): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
  }

  dispatchMouseSequence(target: HTMLElement, eventNames: string[]): void {
    for (const eventName of eventNames) {
      target.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }
  }
}
