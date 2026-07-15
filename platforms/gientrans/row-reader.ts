import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';
import { extractPlaceholderTokens } from '../../domain/qa.ts';
import { normalizeText } from '../../shared/utils.ts';
import { describeGientTransText } from './diagnostics.ts';
import {
  collectGientTransTagHtmlByToken,
  readGientTransEditorText
} from './editor-text.ts';

const GIENTRANS_ROOT_SELECTOR = '#o-editor.online-editor';
const GIENTRANS_TABLE_SELECTOR = '.editor__table';
const GIENTRANS_SCROLL_SELECTOR = '.editor__table .el-scrollbar__wrap';
const GIENTRANS_ROW_SELECTOR = '.editor__table tbody > tr.el-table__row';
const GIENTRANS_SOURCE_SELECTOR =
  'td.source-cell pre.edit__input[editortype="source"]';
const GIENTRANS_TARGET_SELECTOR =
  'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_ROW_NUMBER_SELECTOR = '.sort-index';
const DEBUG_PREFIX = '[Phrase Bulk Fill][GientTrans]';
const MAX_SCAN_DEBUG_LOGS = 12;

/** Owns GientTrans table discovery, segment serialization, and row lookup. */
export class GientTransRowReader {
  private scanDebugCount = 0;

  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  isActive(): boolean {
    return (
      document.querySelector(GIENTRANS_ROOT_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_TABLE_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_ROW_SELECTOR) !== null
    );
  }

  findScrollContext(): ScrollContext | null {
    const tableScrollContainer =
      document.querySelector<HTMLElement>(GIENTRANS_SCROLL_SELECTOR);
    if (
      tableScrollContainer &&
      tableScrollContainer.scrollHeight >
        tableScrollContainer.clientHeight + 8
    ) {
      return this.helpers.toElementScrollContext(tableScrollContainer);
    }

    const candidates = [
      ...Array.from(
        document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR)
      ),
      ...Array.from(
        document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR)
      )
    ];
    const bestContainer = this.helpers.findBestScrollContainer(candidates);

    return bestContainer
      ? this.helpers.toElementScrollContext(bestContainer)
      : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      Array.from(
        document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR)
      ).filter((row) => this.helpers.isElementVisible(row)),
      scrollContext
    );
    const segments: RuntimeSegment[] = [];

    for (const row of rows) {
      const segment = this.extractRowSegment(row, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    this.debugScan(rows, segments);
    return segments;
  }

  getEditableValue(targetElement: HTMLElement): string {
    return readGientTransEditorText(targetElement);
  }

  findCurrentTargetBySegmentId(segmentId: string): HTMLElement | null {
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR)
      ).find((target) => target.getAttribute('segid') === segmentId) ?? null
    );
  }

  collectSourceTagHtmlByToken(target: HTMLElement): Map<string, string[]> {
    const row = target.closest<HTMLElement>(GIENTRANS_ROW_SELECTOR);
    const source =
      row?.querySelector<HTMLElement>(GIENTRANS_SOURCE_SELECTOR) ?? null;
    return collectGientTransTagHtmlByToken(source);
  }

  private extractRowSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const sourceElement = row.querySelector<HTMLElement>(
      GIENTRANS_SOURCE_SELECTOR
    );
    const targetElement = row.querySelector<HTMLElement>(
      GIENTRANS_TARGET_SELECTOR
    );

    if (!sourceElement || !targetElement) {
      return null;
    }

    const sourceRaw = readGientTransEditorText(sourceElement);
    const sourceNormalized = normalizeText(sourceRaw);
    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetElement);
    const rowNumber = normalizeText(
      readGientTransEditorText(
        row.querySelector<HTMLElement>(GIENTRANS_ROW_NUMBER_SELECTOR)
      )
    );
    const domId =
      targetElement.getAttribute('segid') ||
      sourceElement.getAttribute('segid') ||
      row.getAttribute('data-row-key') ||
      row.id ||
      `${sourceNormalized}::${Math.round(
        this.helpers.getAbsoluteTop(row, scrollContext)
      )}`;

    return {
      domId,
      rowNumber: rowNumber || undefined,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement,
      platform: 'gientrans',
      scanElement: row,
      scanFingerprint: `${sourceNormalized}::${normalizeText(targetRaw)}`
    };
  }

  private debugScan(
    rows: HTMLElement[],
    segments: RuntimeSegment[]
  ): void {
    if (!this.isActive() && rows.length === 0 && segments.length === 0) {
      return;
    }
    if (this.scanDebugCount >= MAX_SCAN_DEBUG_LOGS) {
      return;
    }

    this.scanDebugCount += 1;
    console.info(DEBUG_PREFIX, 'scan:visible', {
      scanLog: this.scanDebugCount,
      rowsFound: rows.length,
      segmentsFound: segments.length,
      emptyTargets: segments.filter((segment) => segment.isEmptyTarget).length,
      samples: segments.slice(0, 3).map((segment) => ({
        domId: segment.domId,
        rowNumber: segment.rowNumber ?? null,
        source: describeGientTransText(segment.sourceRaw),
        target: describeGientTransText(segment.targetRaw),
        isEmptyTarget: segment.isEmptyTarget
      }))
    });
  }
}
