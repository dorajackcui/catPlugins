import { normalizeText } from '../shared/utils.ts';
import { ContentScrollHelpers } from './scroll.ts';
import type { EditableElement } from './types.ts';

export {
  ContentScrollHelpers,
  KNOWN_SCROLL_CONTAINER_SELECTORS
} from './scroll.ts';
export type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from './types.ts';

export class ContentScriptDomHelpers extends ContentScrollHelpers {
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
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    for (const eventName of eventNames) {
      target.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          screenX: window.screenX + clientX,
          screenY: window.screenY + clientY
        })
      );
    }
  }
}
