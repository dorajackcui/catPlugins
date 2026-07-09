import { extractPlaceholderTokens } from './qa.ts';
import { normalizeText } from './utils.ts';
import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';
import type { MemoqDomProfile } from './memoq-dom-profile.ts';
import { serializeMemoqContent } from './memoq-text.ts';

const MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR = 'textarea, input[type="text"]';
const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;

export interface MemoqVisibleRowDiagnostic {
  rowNumber?: string;
  source: string;
  target: string;
}

export function readMemoqAccessibilityTextBoxValue(
  textBox: Pick<HTMLInputElement | HTMLTextAreaElement, 'value' | 'textContent'>
): string {
  return normalizeText(textBox.value || textBox.textContent || '');
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

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      this.profile.findVisibleRows(document),
      scrollContext
    );
    const segments: RuntimeSegment[] = [];

    for (const row of rows) {
      const segment = this.extractSegment(row, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return this.dedupeVisibleSegments(segments, scrollContext);
  }

  getEditableValue(targetElement: HTMLElement): string {
    if (targetElement.matches(MEMOQ_ACCESSIBILITY_TEXTBOX_SELECTOR)) {
      return readMemoqAccessibilityTextBoxValue(
        targetElement as HTMLInputElement | HTMLTextAreaElement
      );
    }

    return serializeMemoqContent(this.profile.getContentRoot(targetElement));
  }

  getCurrentEditableValue(segment: RuntimeSegment): string {
    return this.getEditableValue(
      this.findCurrentTargetByRowNumber(segment.rowNumber) ??
        (segment.targetElement as HTMLElement)
    );
  }

  findCurrentTargetByRowNumber(rowNumber?: string): HTMLElement | null {
    if (!rowNumber) {
      return null;
    }

    const target = this.profile.findCurrentTargetByRowNumber(document, rowNumber);
    return target && this.hasClickableRect(target) ? target : null;
  }

  findCurrentCellsByRowNumber(
    rowNumber?: string
  ): { source: HTMLElement; target: HTMLElement } | null {
    if (!rowNumber) {
      return null;
    }

    for (const row of this.profile.findVisibleRows(document)) {
      if (this.profile.readRowNumber(row) !== rowNumber) {
        continue;
      }

      return this.profile.findCells(row);
    }

    return null;
  }

  getCurrentSourceValue(segment: RuntimeSegment): string {
    const cells = this.findCurrentCellsByRowNumber(segment.rowNumber);
    return cells ? this.getEditableValue(cells.source) : segment.sourceRaw;
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
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const cells = this.profile.findCells(row);
    if (!cells) {
      return null;
    }

    const sourceRaw = this.getEditableValue(cells.source);
    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(cells.target);
    const rowNumber = this.profile.readRowNumber(row);
    const domId =
      rowNumber ||
      row.id ||
      row.getAttribute('data-row') ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

    return {
      domId,
      rowNumber,
      sourceRaw,
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
    scrollContext: ScrollContext
  ): RuntimeSegment[] {
    const deduped = new Map<string, RuntimeSegment>();

    for (const segment of segments) {
      const topBucket = Math.round(
        this.helpers.getAbsoluteTop(segment.targetElement as Element, scrollContext) /
          VISIBLE_SEGMENT_TOP_BUCKET_PX
      );
      const visibleKey = `${segment.sourceNormalized}::${topBucket}`;
      const current = deduped.get(visibleKey);

      if (!current) {
        deduped.set(visibleKey, segment);
        continue;
      }

      const currentTarget = normalizeText(current.targetRaw);
      const nextTarget = normalizeText(segment.targetRaw);
      if (currentTarget.length === 0 && nextTarget.length > 0) {
        deduped.set(visibleKey, segment);
      }
    }

    return [...deduped.values()];
  }

  private hasClickableRect(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
}
