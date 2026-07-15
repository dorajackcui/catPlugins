export interface MemoqProfileCells {
  source: HTMLElement;
  target: HTMLElement;
}

export type MemoqDomProfileId = 'legacy-webtrans' | 'modern-editor';

export interface MemoqDomProfile {
  id: MemoqDomProfileId;
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
