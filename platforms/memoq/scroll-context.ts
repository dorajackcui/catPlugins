import type { ContentScrollHelpers } from '../../content/scroll.ts';
import type { ScrollContext } from '../../content/types.ts';
import type { MemoqDomProfile } from './dom-profile.ts';

export interface MemoqScrollEnvironment {
  root: Document;
  getViewportHeight(): number;
  createKeyboardEvent(type: string, init: KeyboardEventInit): KeyboardEvent;
  createWheelEvent(type: string, init: WheelEventInit): WheelEvent;
}

function createBrowserScrollEnvironment(): MemoqScrollEnvironment {
  return {
    root: document,
    getViewportHeight: () => window.innerHeight,
    createKeyboardEvent: (type, init) => new KeyboardEvent(type, init),
    createWheelEvent: (type, init) => new WheelEvent(type, init)
  };
}

export class MemoqScrollContextResolver {
  constructor(
    private readonly profile: MemoqDomProfile,
    private readonly helpers: ContentScrollHelpers,
    private readonly environment: MemoqScrollEnvironment = createBrowserScrollEnvironment()
  ) {}

  resolve(): ScrollContext | null {
    const profileScrollRoot = this.profile.findScrollRoot(this.environment.root);
    if (
      profileScrollRoot &&
      this.helpers.isScrollableContainer(profileScrollRoot, true)
    ) {
      return this.helpers.toElementScrollContext(profileScrollRoot);
    }

    const visibleTargets = this.getVisibleProfileTargets();
    const scrollContainer = this.helpers.findBestScrollContainer(visibleTargets);
    if (scrollContainer) {
      return this.helpers.toElementScrollContext(scrollContainer);
    }

    const syntheticTarget = this.profile.createSyntheticScrollTarget(this.environment.root);
    if (syntheticTarget) {
      return this.createSyntheticScrollContext(syntheticTarget);
    }

    const interactionTarget = this.findSharedAncestor(visibleTargets);
    return interactionTarget ? this.createSyntheticScrollContext(interactionTarget) : null;
  }

  private getVisibleProfileTargets(): HTMLElement[] {
    const targets: HTMLElement[] = [];

    for (const row of this.profile.findVisibleRows(this.environment.root)) {
      const cells = this.profile.findCells(row);
      targets.push(row);

      if (cells) {
        targets.push(cells.source, cells.target);
      }
    }

    return targets.filter((target) => this.helpers.isElementVisible(target));
  }

  private findSharedAncestor(elements: HTMLElement[]): HTMLElement | null {
    const candidates = new Map<HTMLElement, number>();

    for (const element of elements.slice(0, 40)) {
      let ancestor = element.parentElement;
      let depth = 0;

      while (ancestor && ancestor !== this.environment.root.body && depth < 8) {
        const current = candidates.get(ancestor) ?? 0;
        candidates.set(ancestor, current + Math.max(1, 8 - depth));
        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidates.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }

  private createSyntheticScrollContext(target: HTMLElement): ScrollContext {
    let syntheticTop = 0;

    return {
      initialTop: 0,
      mode: 'synthetic',
      getTop: () => syntheticTop,
      getHeight: () => target.clientHeight || this.environment.getViewportHeight(),
      scrollToTop: () => {
        const focusTarget = this.findMemoqFocusTarget(target);

        focusTarget.focus();
        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            this.environment.createKeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'Home',
              code: 'Home',
              ctrlKey: true,
              metaKey: true
            })
          );
          receiver.dispatchEvent(
            this.environment.createKeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'Home',
              code: 'Home',
              ctrlKey: true,
              metaKey: true
            })
          );
        }
        syntheticTop = 0;
      },
      scrollBy: (delta) => {
        const focusTarget = this.findMemoqFocusTarget(target);

        focusTarget.focus();

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            this.environment.createWheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: Math.max(delta, 240)
            })
          );
        }

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            this.environment.createKeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
          receiver.dispatchEvent(
            this.environment.createKeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
        }

        syntheticTop += Math.max(delta, 240);
      },
      isAtBottom: () => false,
      restore: () => {
        // Synthetic scrolling cannot be restored reliably.
      }
    };
  }

  private findMemoqFocusTarget(target: HTMLElement): HTMLElement {
    return target.querySelector<HTMLElement>('[tabindex], textarea, input, [contenteditable="true"]') ??
      target;
  }
}
