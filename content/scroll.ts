import type { ScrollContext } from './types.ts';

export const KNOWN_SCROLL_CONTAINER_SELECTORS = [
  '[data-testid*="virtual"]',
  '[data-testid*="scroll"]',
  '[class*="virtual"]',
  '[class*="scroll"]',
  '[class*="viewport"]',
  '[role="grid"]',
  '[role="table"]'
];

export class ContentScrollHelpers {
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
      scrollToTop: () => container.scrollTo({ top: 0, behavior: 'auto' }),
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
      scrollToTop: () => window.scrollTo({ top: 0, behavior: 'auto' }),
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
}
