import { extractPlaceholderTokens } from '../../domain/qa.ts';
import type { FillOutcome } from '../../shared/fill-outcome-types.ts';
import { delay, normalizeText } from '../../shared/utils.ts';
import {
  collectGientTransTagHtmlByToken,
  containsMappedGientTransTag,
  gientransTextToEditorHtml,
  readGientTransEditorText
} from './editor-text.ts';
import {
  describeGientTransText,
  GientTransEditorWriter,
  type NativeWriteDiagnostic
} from './editor-writer.ts';
import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type { RuntimeSegment, ScrollContext } from '../../content/types.ts';

const GIENTRANS_ROOT_SELECTOR = '#o-editor.online-editor';
const GIENTRANS_TABLE_SELECTOR = '.editor__table';
const GIENTRANS_SCROLL_SELECTOR = '.editor__table .el-scrollbar__wrap';
const GIENTRANS_ROW_SELECTOR = '.editor__table tbody > tr.el-table__row';
const GIENTRANS_SOURCE_SELECTOR = 'td.source-cell pre.edit__input[editortype="source"]';
const GIENTRANS_TARGET_SELECTOR = 'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_ROW_NUMBER_SELECTOR = '.sort-index';
const DEBUG_PREFIX = '[Phrase Bulk Fill][GientTrans]';
const MAX_SCAN_DEBUG_LOGS = 12;

export class GientTransAdapter {
  private scanDebugCount = 0;
  private fillDebugSequence = 0;
  private readonly editorWriter: GientTransEditorWriter;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.editorWriter = new GientTransEditorWriter(helpers, delay);
  }

  isActive(): boolean {
    return (
      document.querySelector(GIENTRANS_ROOT_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_TABLE_SELECTOR) !== null ||
      document.querySelector(GIENTRANS_ROW_SELECTOR) !== null
    );
  }

  findScrollContext(): ScrollContext | null {
    const tableScrollContainer = document.querySelector<HTMLElement>(GIENTRANS_SCROLL_SELECTOR);
    if (
      tableScrollContainer &&
      tableScrollContainer.scrollHeight > tableScrollContainer.clientHeight + 8
    ) {
      return this.helpers.toElementScrollContext(tableScrollContainer);
    }

    const candidates = [
      ...Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR)),
      ...Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR))
    ];
    const bestContainer = this.helpers.findBestScrollContainer(candidates);

    return bestContainer ? this.helpers.toElementScrollContext(bestContainer) : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = this.helpers.sortByVisualPosition(
      Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_ROW_SELECTOR))
        .filter((row) => this.helpers.isElementVisible(row)),
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

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const fillId = ++this.fillDebugSequence;
    const currentTarget = this.findCurrentTargetBySegmentId(segment.domId);
    const target = currentTarget ?? (segment.targetElement as HTMLElement);
    this.debug('fill:start', {
      fillId,
      domId: segment.domId,
      rowNumber: segment.rowNumber ?? null,
      foundCurrentTarget: Boolean(currentTarget),
      source: describeGientTransText(segment.sourceRaw),
      translation: describeGientTransText(value),
      targetBefore: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetAttrs: describeTarget(target)
    });

    if (!this.editorWriter.isWritable(target)) {
      this.debug('fill:skip', {
        fillId,
        reason: 'target-not-writable',
        targetAttrs: describeTarget(target)
      });
      return {
        domId: segment.domId,
        filled: false,
        reason: 'GientTrans target editor is not writable.'
      };
    }

    this.editorWriter.activate(target);
    const tagHtmlByToken = this.collectSourceTagHtmlByToken(target);
    const editorHtml = gientransTextToEditorHtml(value, tagHtmlByToken);
    const containsMappedTags = containsMappedGientTransTag(value, tagHtmlByToken);
    const shouldPreserveEditorHtml = value.includes('\u00A0') || containsMappedTags;
    const nativeWrite = this.editorWriter.writeBeforeInputPaste(target, value, editorHtml);
    let fallbackNativeWrite: NativeWriteDiagnostic;
    let nativeHtmlWrite: NativeWriteDiagnostic | null = null;
    if (nativeWrite.ok) {
      fallbackNativeWrite = nativeWrite;
    } else if (shouldPreserveEditorHtml) {
      fallbackNativeWrite = {
        method: 'skipped' as const,
        attempted: false,
        ok: false,
        reason: containsMappedTags ? 'gientrans-tag-html-path' : 'nbsp-preserve-html-path',
        before: describeGientTransText(this.getEditableValue(target))
      };
    } else {
      fallbackNativeWrite = this.editorWriter.writeText(target, value);
    }

    if (!fallbackNativeWrite.ok) {
      nativeHtmlWrite = this.editorWriter.writeHtml(target, value, editorHtml);
      if (nativeHtmlWrite.ok) {
        fallbackNativeWrite = nativeHtmlWrite;
      }
    }

    if (!fallbackNativeWrite.ok) {
      this.editorWriter.replaceWithHtml(target, editorHtml);
    }

    this.debug('fill:write', {
      fillId,
      nativeWrite,
      fallbackNativeWrite,
      nativeHtmlWrite,
      usedFallbackInnerHtml: !fallbackNativeWrite.ok,
      activeElementMatchesTarget: document.activeElement === target,
      targetAfterWrite: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0
    });

    this.helpers.dispatchInput(target, value);
    this.helpers.dispatchChange(target);
    await delay(20);
    this.helpers.dispatchBlur(target);

    const confirmed = await this.editorWriter.waitForTextMatch(target, value);

    this.debug('fill:complete', {
      fillId,
      confirmed,
      targetAfterEvents: describeGientTransText(this.getEditableValue(target)),
      targetHtmlLength: target.innerHTML?.length ?? 0,
      targetEvents: 'input/change/blur-dispatched'
    });

    return {
      domId: segment.domId,
      filled: confirmed,
      reason: confirmed ? undefined : 'Unable to confirm target update after writing.'
    };
  }

  private extractRowSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const sourceElement = row.querySelector<HTMLElement>(GIENTRANS_SOURCE_SELECTOR);
    const targetElement = row.querySelector<HTMLElement>(GIENTRANS_TARGET_SELECTOR);

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
      readGientTransEditorText(row.querySelector<HTMLElement>(GIENTRANS_ROW_NUMBER_SELECTOR))
    );
    const domId =
      targetElement.getAttribute('segid') ||
      sourceElement.getAttribute('segid') ||
      row.getAttribute('data-row-key') ||
      row.id ||
      `${sourceNormalized}::${Math.round(this.helpers.getAbsoluteTop(row, scrollContext))}`;

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

  private findCurrentTargetBySegmentId(segmentId: string): HTMLElement | null {
    return (
      Array.from(document.querySelectorAll<HTMLElement>(GIENTRANS_TARGET_SELECTOR))
        .find((target) => target.getAttribute('segid') === segmentId) ?? null
    );
  }

  private collectSourceTagHtmlByToken(target: HTMLElement): Map<string, string[]> {
    const row = target.closest<HTMLElement>(GIENTRANS_ROW_SELECTOR);
    const source = row?.querySelector<HTMLElement>(GIENTRANS_SOURCE_SELECTOR) ?? null;
    return collectGientTransTagHtmlByToken(source);
  }

  private debugScan(rows: HTMLElement[], segments: RuntimeSegment[]): void {
    if (!this.isActive() && rows.length === 0 && segments.length === 0) {
      return;
    }

    if (this.scanDebugCount >= MAX_SCAN_DEBUG_LOGS) {
      return;
    }

    this.scanDebugCount += 1;
    this.debug('scan:visible', {
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

  private debug(label: string, payload: Record<string, unknown>): void {
    console.info(DEBUG_PREFIX, label, payload);
  }
}

function describeTarget(target: HTMLElement): Record<string, unknown> {
  return {
    tagName: target.tagName,
    className: target.className,
    contenteditable: target.getAttribute('contenteditable'),
    isContentEditable: target.isContentEditable,
    editortype: target.getAttribute('editortype'),
    segid: target.getAttribute('segid')
  };
}
