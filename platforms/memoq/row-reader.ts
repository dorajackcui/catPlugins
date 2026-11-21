import { extractPlaceholderTokens } from '../../domain/qa.ts';
import { normalizeText } from '../../shared/utils.ts';
import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import { MEMOQ_TEXTBOX_SELECTOR, readMemoqAccessibilityTextBoxValue } from './accessibility-textbox.ts';
import { supportsWebTransInput, type MemoqDomProfile } from './dom-profile.ts';
import { readMemoqNativeMarkers, readMemoqOriginalSource, serializeMemoqContent, serializeMemoqContentExact } from './text.ts';

const VISIBLE_ROW_OVERLAP_RATIO = 0.5;

export interface MemoqVisibleRowDiagnostic {
  rowNumber?: string;
  source: string;
  target: string;
}

export class MemoqRowReader {
  private readonly profile: MemoqDomProfile;
  private readonly helpers: ContentScriptDomHelpers;

  constructor({
    profile,
    helpers
  }: {
    profile: MemoqDomProfile;
    helpers: ContentScriptDomHelpers;
  }) {
    this.profile = profile;
    this.helpers = helpers;
  }

  collectVisibleSegments(scrollContext: ScrollContext, includeEmptySources = false): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      this.profile.findVisibleRows(document),
      scrollContext
    );
    const segments: RuntimeSegment[] = [];
    const canPasteMarkers = supportsWebTransInput(this.profile);

    for (const row of rows) {
      const segment = this.extractSegment(row, scrollContext, canPasteMarkers, includeEmptySources);
      if (segment) {
        segments.push(segment);
      }
    }

    return this.dedupeVisibleSegments(segments, scrollContext);
  }

  getEditableValue(targetElement: HTMLElement): string {
    if (targetElement.matches(MEMOQ_TEXTBOX_SELECTOR)) {
      return readMemoqAccessibilityTextBoxValue(
        targetElement as HTMLInputElement | HTMLTextAreaElement
      );
    }

    return serializeMemoqContent(this.profile.getContentRoot(targetElement));
  }

  private readRawCell(cell: HTMLElement, content?: HTMLElement): string {
    if (cell.matches(MEMOQ_TEXTBOX_SELECTOR)) {
      return (cell as HTMLInputElement | HTMLTextAreaElement).value ?? cell.textContent ?? '';
    }
    return serializeMemoqContentExact(content ?? this.profile.getContentRoot(cell));
  }

  findCurrentTargetByRowNumber(rowNumber?: string): HTMLElement | null {
    const target = this.findCurrentCellsByRowNumber(rowNumber)?.target ?? null;
    return target && this.hasClickableRect(target) ? target : null;
  }

  findCurrentCellsByRowNumber(
    rowNumber?: string
  ): { source: HTMLElement; target: HTMLElement } | null {
    if (!rowNumber) {
      return null;
    }

    const matches: Array<{ source: HTMLElement; target: HTMLElement }> = [];

    for (const row of this.profile.findVisibleRows(document)) {
      if (this.profile.readRowNumber(row) !== rowNumber) {
        continue;
      }

      const cells = this.profile.findCells(row);
      if (cells && this.hasClickableRect(cells.source) && this.hasClickableRect(cells.target)) {
        matches.push(cells);
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  getCurrentSourceValue(segment: RuntimeSegment): string | null {
    if (!segment.rowNumber) {
      return segment.sourceRaw;
    }

    const cells = this.findCurrentCellsByRowNumber(segment.rowNumber);
    return cells ? this.getEditableValue(cells.source) : null;
  }

  matchesCurrentMarkerSource(segment: RuntimeSegment): boolean {
    const cells = segment.rowNumber ? this.findCurrentCellsByRowNumber(segment.rowNumber)
      : segment.scanElement?.isConnected ? this.profile.findCells(segment.scanElement as HTMLElement) : null;
    if (!cells || normalizeText(this.getEditableValue(cells.source)) !== segment.sourceNormalized) return false;
    if (!segment.memoqSourceMarkers) return true;
    const current = readMemoqNativeMarkers(this.profile.getContentRoot(cells.source));
    return current.length === segment.memoqSourceMarkers.length &&
      segment.memoqSourceMarkers.every((token, i) => token === current[i]);
  }

  collectVisibleRowDiagnostics(
    targetRowNumber?: string,
    radius = 2
  ): MemoqVisibleRowDiagnostic[] {
    const diagnostics: MemoqVisibleRowDiagnostic[] = [];

    for (const row of this.profile.findVisibleRows(document)) {
      const cells = this.profile.findCells(row);
      if (!cells) {
        continue;
      }

      diagnostics.push({
        rowNumber: this.profile.readRowNumber(row),
        source: this.getEditableValue(cells.source),
        target: this.getEditableValue(cells.target)
      });
    }

    if (!targetRowNumber) {
      return diagnostics.slice(-5);
    }

    const targetIndex = diagnostics.findIndex((row) => row.rowNumber === targetRowNumber);
    if (targetIndex === -1) {
      return diagnostics.slice(-5);
    }

    return diagnostics.slice(
      Math.max(0, targetIndex - radius),
      targetIndex + radius + 1
    );
  }

  private extractSegment(
    row: HTMLElement,
    scrollContext: ScrollContext,
    canPasteMarkers: boolean,
    includeEmptySources: boolean
  ): RuntimeSegment | null {
    if (row.classList.contains('not-loaded-row')) return null;
    const cells = this.profile.findCells(row);
    if (!cells) {
      return null;
    }

    const sourceContent = this.profile.getContentRoot(cells.source);
    const sourceRaw = this.readRawCell(cells.source, sourceContent);
    const sourceNormalized = normalizeText(sourceRaw);
    const rowNumber = this.profile.readRowNumber(row);
    if (!sourceNormalized && !(includeEmptySources && rowNumber)) {
      return null;
    }

    const targetRaw = this.readRawCell(cells.target);
    const originalSource = sourceContent.querySelector('.tag') ? readMemoqOriginalSource(sourceContent) : undefined;
    const domId =
      rowNumber ||
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      rowNumber,
      sourceRaw,
      ...(canPasteMarkers ? { memoqSourceMarkers: readMemoqNativeMarkers(sourceContent) } : {}),
      ...(originalSource !== undefined ? { originalSource } : {}),
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement: cells.target,
      platform: 'memoq',
      scanElement: row,
      scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
    };
  }

  private dedupeVisibleSegments(
    segments: RuntimeSegment[],
    _scrollContext: ScrollContext
  ): RuntimeSegment[] {
    const deduped: RuntimeSegment[] = [];

    for (const segment of segments) {
      const duplicateIndex = deduped.findIndex((current) =>
        this.areLikelySameVisibleRow(current, segment)
      );
      if (duplicateIndex === -1) {
        deduped.push(segment);
        continue;
      }

      const current = deduped[duplicateIndex];
      const currentTarget = normalizeText(current.targetRaw);
      const nextTarget = normalizeText(segment.targetRaw);
      if (currentTarget.length === 0 && nextTarget.length > 0) {
        deduped[duplicateIndex] = segment;
      }
    }

    return deduped;
  }

  private areLikelySameVisibleRow(
    current: RuntimeSegment,
    next: RuntimeSegment
  ): boolean {
    if (current.rowNumber && next.rowNumber && current.rowNumber === next.rowNumber) {
      return true;
    }

    if (current.sourceNormalized !== next.sourceNormalized) {
      return false;
    }

    const currentRect = (current.targetElement as Element).getBoundingClientRect();
    const nextRect = (next.targetElement as Element).getBoundingClientRect();
    const currentBottom = currentRect.top + currentRect.height;
    const nextBottom = nextRect.top + nextRect.height;
    const overlap = Math.min(currentBottom, nextBottom) - Math.max(currentRect.top, nextRect.top);
    const smallerHeight = Math.min(currentRect.height, nextRect.height);

    return smallerHeight > 0 && overlap / smallerHeight >= VISIBLE_ROW_OVERLAP_RATIO;
  }

  private hasClickableRect(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}
