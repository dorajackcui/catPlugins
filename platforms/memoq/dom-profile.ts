export interface MemoqProfileCells {
  source: HTMLElement;
  target: HTMLElement;
}

export interface MemoqDomProfile {
  id: 'legacy-webtrans' | 'modern-editor';
  matches(root: ParentNode): boolean;
  findVisibleRows(root: ParentNode): HTMLElement[];
  findCells(row: HTMLElement): MemoqProfileCells | null;
  readRowNumber(row: HTMLElement): string | undefined;
  findScrollRoot(root: ParentNode): HTMLElement | null;
  findCurrentTargetByRowNumber(root: ParentNode, rowNumber: string): HTMLElement | null;
  getContentRoot(cell: HTMLElement): HTMLElement;
  getWriteTarget(targetCell: HTMLElement): HTMLElement;
  createSyntheticScrollTarget(root: ParentNode): HTMLElement | null;
}

const LEGACY_CELL_SELECTOR = '.editor-cell';
const LEGACY_CONTENT_SELECTOR = '.content-container';
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

function queryAll(root: ParentNode | HTMLElement, selector: string): HTMLElement[] {
  if (typeof root.querySelectorAll !== 'function') {
    return [];
  }

  return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
}

function getRect(element: HTMLElement): DOMRect | null {
  if (typeof element.getBoundingClientRect !== 'function') {
    return null;
  }

  try {
    return element.getBoundingClientRect();
  } catch {
    return null;
  }
}

function isVisible(element: HTMLElement): boolean {
  const rect = getRect(element);
  if (!rect) {
    return true;
  }

  return rect.width > 0 && rect.height > 0;
}

function sortByLeft(cells: HTMLElement[]): HTMLElement[] {
  return [...cells].sort((left, right) => {
    const leftRect = getRect(left);
    const rightRect = getRect(right);
    return (leftRect?.left ?? 0) - (rightRect?.left ?? 0);
  });
}

function findLegacyRowContainer(cell: HTMLElement): HTMLElement | null {
  let cursor = cell.parentElement;

  while (cursor) {
    if (queryAll(cursor, LEGACY_CELL_SELECTOR).length >= 2) {
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
  const cells = queryAll(row, MODERN_CELL_SELECTOR).filter(isVisible);
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

  for (const cell of queryAll(row, MODERN_CELL_SELECTOR)) {
    const rowNumber = readModernStableRowNumber(cell);
    if (rowNumber) {
      return rowNumber;
    }
  }

  const rowContextualNumber = readModernContextualRowNumberFromAttributes(row);
  if (rowContextualNumber) {
    return rowContextualNumber;
  }

  for (const cell of queryAll(row, MODERN_CELL_SELECTOR)) {
    const rowNumber = readModernContextualRowNumberFromAttributes(cell);
    if (rowNumber) {
      return rowNumber;
    }
  }

  return undefined;
}

export const legacyWebtransMemoqProfile: MemoqDomProfile = {
  id: 'legacy-webtrans',
  matches(root) {
    return queryAll(root, LEGACY_CELL_SELECTOR).length > 0;
  },
  findVisibleRows(root) {
    const rows: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    for (const cell of queryAll(root, LEGACY_CELL_SELECTOR).filter(isVisible)) {
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
    const cells = sortByLeft(queryAll(row, LEGACY_CELL_SELECTOR).filter(isVisible));
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

export const modernEditorMemoqProfile: MemoqDomProfile = {
  id: 'modern-editor',
  matches(root) {
    return queryAll(root, MODERN_CELL_SELECTOR).length > 0;
  },
  findVisibleRows(root) {
    const rows: HTMLElement[] = [];

    for (const row of queryAll(root, MODERN_ROW_SELECTOR).filter(hasAncestorTable)) {
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
      queryAll(root, MODERN_TABLE_SELECTOR)[0] ??
      null;
  }
};

export function selectMemoqDomProfile(root: ParentNode = document): MemoqDomProfile | null {
  const matches = [modernEditorMemoqProfile, legacyWebtransMemoqProfile].filter((profile) =>
    profile.matches(root)
  );

  for (const profile of matches) {
    if (profile.findVisibleRows(root).length > 0) {
      return profile;
    }
  }

  return matches[0] ?? null;
}

export function findMemoqStartTargetCell(
  root: ParentNode,
  element: Element
): HTMLElement | null {
  const profile = selectMemoqDomProfile(root);
  if (!profile) {
    return null;
  }

  for (const row of profile.findVisibleRows(root)) {
    if (!elementsOverlap(row, element)) {
      continue;
    }

    return profile.findCells(row)?.target ?? null;
  }

  return null;
}

function elementsOverlap(left: Element, right: Element): boolean {
  return (
    left === right ||
    safelyContains(left, right) ||
    safelyContains(right, left)
  );
}

function safelyContains(parent: Element, child: Element): boolean {
  if (typeof parent.contains === 'function' && parent.contains(child)) {
    return true;
  }

  let cursor = (child as HTMLElement).parentElement;
  while (cursor) {
    if (cursor === parent) {
      return true;
    }

    cursor = cursor.parentElement;
  }

  return false;
}
