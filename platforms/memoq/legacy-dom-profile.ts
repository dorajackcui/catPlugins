import {
  isMemoqElementVisible,
  queryMemoqElements,
  sortMemoqElementsByLeft
} from './dom-profile-helpers.ts';
import type { MemoqDomProfile } from './dom-profile-types.ts';

const LEGACY_CELL_SELECTOR = '.editor-cell';
const LEGACY_CONTENT_SELECTOR = '.content-container';

function findLegacyRowContainer(cell: HTMLElement): HTMLElement | null {
  let cursor = cell.parentElement;

  while (cursor) {
    if (queryMemoqElements(cursor, LEGACY_CELL_SELECTOR).length >= 2) {
      return cursor;
    }

    cursor = cursor.parentElement;
  }

  return null;
}

function getElementChildren(element: HTMLElement): HTMLElement[] {
  return Array.from((element.children ?? []) as ArrayLike<Element>) as HTMLElement[];
}

function readLegacyRowNumber(row: HTMLElement): string | undefined {
  for (const child of getElementChildren(row)) {
    if (typeof child.matches === 'function' && child.matches(LEGACY_CELL_SELECTOR)) {
      continue;
    }

    const text = (child.innerText || child.textContent || '').trim();
    const match = text.match(/^(\d+)\.?$/);
    if (match) {
      return match[1];
    }
  }

  const ariaRowIndex = row.getAttribute?.('aria-rowindex');
  return ariaRowIndex && /^\d+$/.test(ariaRowIndex) ? ariaRowIndex : undefined;
}

export const legacyWebtransMemoqProfile: MemoqDomProfile = {
  id: 'legacy-webtrans',
  matches(root) {
    return queryMemoqElements(root, LEGACY_CELL_SELECTOR).length > 0;
  },
  findVisibleRows(root) {
    const rows: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    for (const cell of queryMemoqElements(root, LEGACY_CELL_SELECTOR).filter(isMemoqElementVisible)) {
      const row = findLegacyRowContainer(cell);
      if (!row || seen.has(row)) {
        continue;
      }

      if (!legacyWebtransMemoqProfile.findCells(row)) {
        continue;
      }

      seen.add(row);
      rows.push(row);
    }

    return rows;
  },
  findCells(row) {
    const cells = sortMemoqElementsByLeft(
      queryMemoqElements(row, LEGACY_CELL_SELECTOR).filter(isMemoqElementVisible)
    );
    if (cells.length < 2) {
      return null;
    }

    return {
      source: cells[0],
      target: cells[cells.length - 1]
    };
  },
  readRowNumber(row) {
    return readLegacyRowNumber(row);
  },
  findScrollRoot() {
    return null;
  },
  findCurrentTargetByRowNumber(root, rowNumber) {
    for (const row of legacyWebtransMemoqProfile.findVisibleRows(root)) {
      if (legacyWebtransMemoqProfile.readRowNumber(row) !== rowNumber) {
        continue;
      }

      return legacyWebtransMemoqProfile.findCells(row)?.target ?? null;
    }

    return null;
  },
  getContentRoot(cell) {
    return cell.querySelector<HTMLElement>(LEGACY_CONTENT_SELECTOR) ?? cell;
  },
  getWriteTarget(targetCell) {
    return targetCell;
  },
  createSyntheticScrollTarget() {
    return null;
  }
};
