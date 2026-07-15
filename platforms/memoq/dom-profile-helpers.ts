export function queryMemoqElements(root: ParentNode, selector: string): HTMLElement[] {
  if (typeof root.querySelectorAll !== 'function') {
    return [];
  }

  return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
}

function getMemoqElementRect(element: HTMLElement): DOMRect | null {
  if (typeof element.getBoundingClientRect !== 'function') {
    return null;
  }

  try {
    return element.getBoundingClientRect();
  } catch {
    return null;
  }
}

export function isMemoqElementVisible(element: HTMLElement): boolean {
  const rect = getMemoqElementRect(element);
  if (!rect) {
    return true;
  }

  return rect.width > 0 && rect.height > 0;
}

export function sortMemoqElementsByLeft(elements: HTMLElement[]): HTMLElement[] {
  return [...elements].sort((left, right) => {
    const leftRect = getMemoqElementRect(left);
    const rightRect = getMemoqElementRect(right);
    return (leftRect?.left ?? 0) - (rightRect?.left ?? 0);
  });
}
