import { legacyWebtransMemoqProfile } from './legacy-dom-profile.ts';
import { modernEditorMemoqProfile } from './modern-dom-profile.ts';
import type { MemoqDomProfile } from './dom-profile-types.ts';

export { legacyWebtransMemoqProfile } from './legacy-dom-profile.ts';
export { modernEditorMemoqProfile } from './modern-dom-profile.ts';
export type {
  MemoqDomProfile,
  MemoqDomProfileId,
  MemoqProfileCells
} from './dom-profile-types.ts';

export const MEMOQ_DOM_PROFILES: readonly MemoqDomProfile[] = [
  modernEditorMemoqProfile,
  legacyWebtransMemoqProfile
];

export function selectMemoqDomProfile(root: ParentNode = document): MemoqDomProfile | null {
  const matches = MEMOQ_DOM_PROFILES.filter((profile) => profile.matches(root));

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
  const match = findMemoqStartRow(root, element);
  return match ? match.profile.findCells(match.row)?.target ?? null : null;
}

export function readMemoqStartMarkerDomId(
  root: ParentNode,
  element: Element
): string | null {
  const match = findMemoqStartRow(root, element);
  return match ? match.profile.readRowNumber(match.row) ?? null : null;
}

function findMemoqStartRow(
  root: ParentNode,
  element: Element
): { profile: MemoqDomProfile; row: HTMLElement } | null {
  const profile = selectMemoqDomProfile(root);
  if (!profile) {
    return null;
  }

  for (const row of profile.findVisibleRows(root)) {
    if (!elementsOverlap(row, element)) {
      continue;
    }

    return { profile, row };
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
