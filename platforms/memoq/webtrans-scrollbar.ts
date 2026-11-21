import type { ScrollContext } from '../../content/types.ts';
import { createWebTransExportReader } from './webtrans-export-rows.ts';

/** webTrans recycles grid rows and scrolls them through its own arrow controls. */
export function createWebTransScrollbar(doc: Document): ScrollContext | null {
  const grid = doc.getElementById?.('gridContainer');
  const track = grid?.querySelector<HTMLElement>('.vertical-scrollbar');
  const body = doc.getElementById?.('gridTableBody');
  if (!track || !body || track.getBoundingClientRect().height <= 0) return null;
  const up = track.querySelector<HTMLElement>('.vertical-scrollbar-up-button');
  const down = track.querySelector<HTMLElement>('.vertical-scrollbar-down-button');
  const thumb = track.querySelector<HTMLElement>('.vertical-scrollbar-thumb');
  if (!up || !down || !thumb) return null;

  const enabled = (button: HTMLElement) => button.classList.contains('scrollbar-button-enabled');
  const rows = () => Array.from(body.querySelectorAll<HTMLElement>('tr'))
    .filter(row => row.getBoundingClientRect().height > 0);
  const rowId = (row?: HTMLElement) => row?.querySelector('.order')?.textContent ?? '';
  const state = () => {
    const page = rows();
    return [rowId(page[0]), rowId(page.at(-1)), page[0]?.getBoundingClientRect().top, thumb.style.top].join('|');
  };
  const thumbTop = () => parseFloat(thumb.style.top) || 0;
  const initialTop = thumbTop();
  const initialBoundary = !enabled(up) ? up : !enabled(down) ? down : null;
  let stepsFromStart = 0;

  async function moved(button: HTMLElement, before: string, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (!enabled(button) || state() !== before) return true;
      await new Promise(resolve => setTimeout(resolve, 24));
    }
    return !enabled(button) || state() !== before;
  }
  async function step(button: HTMLElement): Promise<void> {
    const before = state();
    const rect = button.getBoundingClientRect();
    const point = {
      bubbles: true, cancelable: true, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    const PointerMouseEvent = doc.defaultView?.MouseEvent ?? MouseEvent;
    button.dispatchEvent(new PointerMouseEvent('mousedown', { ...point, buttons: 1 }));
    button.dispatchEvent(new PointerMouseEvent('mouseup', point));
    if (!await moved(button, before, 8)) {
      button.click();
      if (!await moved(button, before, 45)) {
        throw new Error('The memoQ scrollbar is still enabled but the visible grid did not advance.');
      }
    }
    stepsFromStart += button === down ? 1 : -1;
  }
  return {
    initialTop, mode: 'synthetic', hasVerifiedScrollBounds: true,
    readExportRowNumbers: createWebTransExportReader(doc, rows, async () => {
      if (!enabled(up)) return false;
      await step(up);
      return true;
    }),
    getTop: thumbTop, getHeight: () => track.getBoundingClientRect().height,
    isAtBottom: () => !enabled(down),
    scrollToTop: async checkStop => {
      while (enabled(up)) {
        checkStop?.();
        await step(up);
      }
    },
    scrollBy: async () => {
      // Keep at least one row of overlap when rows fit. A row taller than
      // the viewport advances one scrollbar step at a time.
      const page = rows();
      const firstIds = new Set(page.slice(0, -1).map(rowId));
      for (let i = 0; enabled(down) && i < Math.max(1, page.length - 1); i++) {
        await step(down);
        if (!firstIds.has(rowId(rows()[0]))) break;
      }
    },
    restore: async () => {
      if (initialBoundary) {
        while (enabled(initialBoundary)) await step(initialBoundary);
        return;
      }
      while (stepsFromStart !== 0) {
        const button = stepsFromStart > 0 ? up : down;
        if (!enabled(button)) break;
        await step(button);
      }
    }
  };
}
