import type { ContentScriptDomHelpers } from '../../content/dom.ts';
import type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from '../../content/types.ts';
import { extractPlaceholderTokens } from '../../domain/qa.ts';
import { isEmptyPhraseCell, type PhraseCellContent } from '../../domain/phrase-marker-fill.ts';
import { normalizeText } from '../../shared/utils.ts';

const ROW_SELECTOR = '.segment-row, .twe_segment';
const TARGET_SELECTOR = '.twe_target';
const SOURCE_TEXT_SELECTOR = '.text-area-source-container .te_text_container, .twe_source .te_text_container';
const SCROLL_SELECTOR = '#translation-table-virtual-scroll';
const SOURCE_SELECTORS = [
  '[data-testid*="source"]',
  '[data-test*="source"]',
  '[data-qa*="source"]',
  '[class*="source"]'
];
const CONTAINER_SELECTORS = [
  '[data-testid*="segment"]',
  '[data-testid*="row"]',
  '[data-qa*="segment"]',
  '[class*="segment"]',
  '[class*="editor-row"]'
];
const EDITABLE_SELECTORS = [
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-qa*="target"]'
];

/** Owns Phrase and generic editor DOM discovery and segment serialization. */
export class PhraseRowReader {
  constructor(private readonly helpers: ContentScriptDomHelpers) {}

  findScrollContext(): ScrollContext | null {
    const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTOR) ??
      this.helpers.findBestScrollContainer(Array.from(document.querySelectorAll<HTMLElement>(
        [ROW_SELECTOR, TARGET_SELECTOR, ...EDITABLE_SELECTORS].join(',')
      )));
    return scroller ? this.helpers.toElementScrollContext(scroller) : null;
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    if (rows.length || document.querySelector(SCROLL_SELECTOR)) {
      const visibleRows = this.helpers.sortByVisualPosition(
        rows.filter(row => this.helpers.isElementVisible(row)), scrollContext
      );
      return visibleRows.flatMap(row => {
        const segment = this.extractRowSegment(row);
        return segment ? [segment] : [];
      });
    }

    const editables = this.helpers.sortByVisualPosition(
      Array.from(
        document.querySelectorAll<EditableElement>(EDITABLE_SELECTORS.join(','))
      ).filter((element) => this.helpers.isEditableCandidate(element)),
      scrollContext
    );
    const segments: RuntimeSegment[] = [];

    for (const editable of editables) {
      const segment = this.extractGenericSegment(editable, scrollContext);
      if (segment) {
        segments.push(segment);
      }
    }

    return segments;
  }

  getEditableValue(targetElement: EditableElement): string {
    return targetElement.matches(TARGET_SELECTOR)
      ? this.readTarget(targetElement)?.text ?? ''
      : this.helpers.getGenericEditableValue(targetElement);
  }

  readTarget(target: HTMLElement): PhraseCellContent | null {
    return readPhraseCell(target.querySelector('.te_text_container'));
  }

  resolveTarget(segment: RuntimeSegment): HTMLElement | null {
    const { targetElement, domId } = segment;
    const row = targetElement.ownerDocument.getElementById(domId) ?? targetElement.closest<HTMLElement>(ROW_SELECTOR);
    if (!row?.isConnected || readRowId(row) !== domId ||
      readRowNumber(row) !== segment.rowNumber) return null;

    const source = readPhraseCell(row.querySelector(SOURCE_TEXT_SELECTOR));
    const savedMarkers = segment.phraseSourceMarkers ?? [];
    if (!source || source.text !== segment.sourceRaw || source.markers.length !== savedMarkers.length ||
      source.markers.some(({ id, token, label, offset }, index) => {
        const before = savedMarkers[index];
        return id !== before.id || token !== before.token || label !== before.label || offset !== before.offset;
      })) return null;

    return row.querySelector(TARGET_SELECTOR);
  }

  private extractRowSegment(row: HTMLElement): RuntimeSegment | null {
    const domId = readRowId(row);
    const targetElement = row.querySelector<HTMLElement>(TARGET_SELECTOR);
    if (!domId || !targetElement) return null;

    const source = readPhraseCell(row.querySelector(SOURCE_TEXT_SELECTOR));
    const target = this.readTarget(targetElement);
    if (!source || !target) return null;
    const sourceNormalized = normalizeText(source.text);
    if (!sourceNormalized) return null;

    const rowNumber = readRowNumber(row);

    return {
      domId,
      ...(rowNumber && { rowNumber }),
      sourceRaw: source.text,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw: target.text,
      isEmptyTarget: isEmptyPhraseCell(target),
      placeholderTokens: extractPlaceholderTokens(source.text),
      targetElement,
      platform: 'phrase',
      ...(source.markers.length && { phraseSourceMarkers: source.markers }),
      ...(target.markers.length && { phraseTargetMarkers: target.markers })
    };
  }

  private extractGenericSegment(
    targetElement: EditableElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const container = this.helpers.findSegmentContainer(
      targetElement,
      CONTAINER_SELECTORS
    );
    const sourceRaw = this.helpers.findSourceText(
      container,
      targetElement,
      SOURCE_SELECTORS
    );
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetRaw = this.getEditableValue(targetElement);
    const absoluteTop = this.helpers.getAbsoluteTop(
      targetElement,
      scrollContext
    );
    const domId = `${sourceNormalized}::${Math.round(absoluteTop)}`;

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: normalizeText(targetRaw) === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement,
      platform: 'generic'
    };
  }
}

function readRowId(row: HTMLElement): string | null {
  return row.id || row.getAttribute('data-position');
}

function readRowNumber(row: HTMLElement): string | undefined {
  const value = row.querySelector('.twe_position .position_number')?.textContent?.trim();
  return value && /^\d+$/.test(value) ? value : undefined;
}

function readPhraseCell(root: Element | null): PhraseCellContent | null {
  if (!root) return null;

  const content: PhraseCellContent = { text: '', markers: [] };
  function readNode(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      content.text += node.textContent ?? '';
      return true;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return true;

    const element = node as Element;
    if (element.matches('.te_tag')) {
      const token = element.getAttribute('data-tag-content') ?? '';
      const rawId = element.getAttribute('data-tag-id');
      const id = Number(rawId);
      if (!token || !rawId || !Number.isSafeInteger(id) || id < 0) return false;

      const label = element.querySelector('.tag_metadata_content')?.textContent || token;
      content.markers.push({ id, token, label, offset: content.text.length });
      content.text += label;
      return true;
    }
    if (element.tagName === 'BR') content.text += '\n';
    for (const child of Array.from(element.childNodes)) {
      if (!readNode(child)) return false;
    }
    return true;
  }

  return readNode(root) ? content : null;
}
