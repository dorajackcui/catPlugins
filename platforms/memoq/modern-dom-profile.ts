import {
  isMemoqElementVisible,
  queryMemoqElements
} from './dom-profile-helpers.ts';
import type { MemoqDomProfile, MemoqProfileCells } from './dom-profile-types.ts';

const MODERN_CELL_SELECTOR = '.ProseMirror[contenteditable="true"][role="gridcell"]';
const MODERN_ROW_SELECTOR = '[role="row"]';
const MODERN_TABLE_SELECTOR = '[role="table"]';
const SOURCE_LABEL_RE = /source|original|\u539f\u6587/i;
const TARGET_LABEL_RE = /target|\u76ee\u6807/i;
const MODERN_CONTEXTUAL_ROW_NUMBER_RE = /(?:row|line|\u884c)\s*(\d+)/i;
const MODERN_ANY_ROW_NUMBER_RE = /(\d+)/;
const MODERN_EXACT_ROW_NUMBER_RE = /^\d+$/;
const MODERN_STABLE_ROW_NUMBER_ATTRIBUTES = [
  'aria-rowindex',
  'data-row',
  'data-rowindex',
  'data-row-index',
  'data-row-number',
  'data-index'
];
const MODERN_CONTEXTUAL_ROW_NUMBER_ATTRIBUTES = [
  'aria-label',
  'aria-description',
  'title'
];

function getAccessibleLabel(element: HTMLElement): string {
  return (
    element.getAttribute?.('aria-label') ||
    element.getAttribute?.('aria-description') ||
    ''
  ).trim();
}

function getModernCellClassificationText(element: HTMLElement): string {
  return `${getAccessibleLabel(element)} ${element.className || ''}`.trim();
}

function readModernContextualRowNumber(label: string): string | undefined {
  return label.match(MODERN_CONTEXTUAL_ROW_NUMBER_RE)?.[1];
}

function readModernStableRowNumber(element: HTMLElement): string | undefined {
  for (const attributeName of MODERN_STABLE_ROW_NUMBER_ATTRIBUTES) {
    const value = element.getAttribute?.(attributeName)?.trim();
    if (!value) {
      continue;
    }

    if (MODERN_EXACT_ROW_NUMBER_RE.test(value)) {
      return value;
    }

    if (attributeName === 'data-index') {
      continue;
    }

    const rowNumber = value.match(MODERN_ANY_ROW_NUMBER_RE)?.[1];
    if (rowNumber) {
      return rowNumber;
    }
  }

  return undefined;
}

function readModernContextualRowNumberFromAttributes(element: HTMLElement): string | undefined {
  for (const attributeName of MODERN_CONTEXTUAL_ROW_NUMBER_ATTRIBUTES) {
    const value = element.getAttribute?.(attributeName)?.trim();
    if (!value) {
      continue;
    }

    const rowNumber = readModernContextualRowNumber(value);
    if (rowNumber) {
      return rowNumber;
    }
  }

  return undefined;
}

function hasAncestorTable(element: HTMLElement): boolean {
  let cursor = element.parentElement;

  while (cursor) {
    if (cursor.getAttribute?.('role') === 'table') {
      return true;
    }

    cursor = cursor.parentElement;
  }

  return false;
}

function findModernTable(row: HTMLElement): HTMLElement | null {
  let cursor: HTMLElement | null = row;

  while (cursor) {
    if (cursor.getAttribute?.('role') === 'table') {
      return cursor;
    }

    cursor = cursor.parentElement;
  }

  return null;
}

function findModernCells(row: HTMLElement): MemoqProfileCells | null {
  const cells = queryMemoqElements(row, MODERN_CELL_SELECTOR).filter(isMemoqElementVisible);
  if (cells.length < 2) {
    return null;
  }

  const source = cells.find((cell) => SOURCE_LABEL_RE.test(getModernCellClassificationText(cell)));
  const target = cells.find((cell) => TARGET_LABEL_RE.test(getModernCellClassificationText(cell)));

  if (!source || !target) {
    return null;
  }

  return { source, target };
}

function readModernRowNumber(row: HTMLElement): string | undefined {
  const rowAttributeNumber = readModernStableRowNumber(row);
  if (rowAttributeNumber) {
    return rowAttributeNumber;
  }

  for (const cell of queryMemoqElements(row, MODERN_CELL_SELECTOR)) {
    const rowNumber = readModernStableRowNumber(cell);
    if (rowNumber) {
      return rowNumber;
    }
  }

  const rowContextualNumber = readModernContextualRowNumberFromAttributes(row);
  if (rowContextualNumber) {
    return rowContextualNumber;
  }

  for (const cell of queryMemoqElements(row, MODERN_CELL_SELECTOR)) {
    const rowNumber = readModernContextualRowNumberFromAttributes(cell);
    if (rowNumber) {
      return rowNumber;
    }
  }

  return undefined;
}

export const modernEditorMemoqProfile: MemoqDomProfile = {
  id: 'modern-editor',
  matches(root) {
    return queryMemoqElements(root, MODERN_CELL_SELECTOR).length > 0;
  },
  findVisibleRows(root) {
    const rows: HTMLElement[] = [];

    for (const row of queryMemoqElements(root, MODERN_ROW_SELECTOR).filter(hasAncestorTable)) {
      if (!modernEditorMemoqProfile.findCells(row)) {
        continue;
      }

      rows.push(row);
    }

    return rows;
  },
  findCells(row) {
    return findModernCells(row);
  },
  readRowNumber(row) {
    return readModernRowNumber(row);
  },
  findScrollRoot(root) {
    return modernEditorMemoqProfile.findVisibleRows(root)
      .map(findModernTable)
      .find((table): table is HTMLElement => table !== null) ?? null;
  },
  findCurrentTargetByRowNumber(root, rowNumber) {
    for (const row of modernEditorMemoqProfile.findVisibleRows(root)) {
      if (modernEditorMemoqProfile.readRowNumber(row) !== rowNumber) {
        continue;
      }

      return modernEditorMemoqProfile.findCells(row)?.target ?? null;
    }

    return null;
  },
  getContentRoot(cell) {
    return cell;
  },
  getWriteTarget(targetCell) {
    return targetCell;
  },
  createSyntheticScrollTarget(root) {
    return modernEditorMemoqProfile.findScrollRoot(root) ??
      queryMemoqElements(root, MODERN_TABLE_SELECTOR)[0] ??
      null;
  }
};
