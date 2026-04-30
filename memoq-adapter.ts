import type {
  ContentScriptDomHelpers,
  RuntimeSegment,
  ScrollContext
} from './content-script-dom.ts';
import { NOOP_MEMOQ_DIAGNOSTICS } from './memoq-debug.ts';
import type { MemoqDiagnostics } from './memoq-debug.ts';
import { extractPlaceholderTokens } from './qa.ts';
import type { FillOutcome } from './types.ts';
import { delay, normalizeText } from './utils.ts';

declare global {
  interface Window {
    __memoqTrackedRow?: HTMLElement | null;
    __memoqTrackedCell?: HTMLElement | null;
    __memoqInteractionTrackingBound?: boolean;
  }
}

const MEMOQ_CELL_SELECTOR = '.editor-cell';
const MEMOQ_CONTENT_SELECTOR = '.content-container';
const MEMOQ_HIDDEN_RELAY_SELECTORS = ['#editorHiddenInput', 'input[id*="HiddenInput"]'];
const VISIBLE_SEGMENT_TOP_BUCKET_PX = 24;
const MEMOQ_CONFIRM_ATTEMPTS = 6;
const MEMOQ_CONFIRM_DELAY_MS = 60;
const MEMOQ_ACTIVATION_DELAY_MS = 60;
const MEMOQ_CURSOR_NAVIGATION_DELAY_MS = 80;
const MEMOQ_CURSOR_PROBE_ATTEMPTS = 6;
const MEMOQ_CURSOR_END_PROBE_COUNT = 4;
const MEMOQ_CURSOR_SCROLL_RATIO = 0.2;
const MEMOQ_CURSOR_SCROLL_MIN_PX = 96;
const MEMOQ_CURSOR_SCROLL_MAX_PX = 160;
const MEMOQ_RENDER_SEPARATOR_RE = /[\u00B7\u2022\u2027\u2219]/g;
const MEMOQ_NON_BREAKING_SPACE_RE = /[\u00A0\u202F]/g;
const MEMOQ_ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const MEMOQ_ACTIVITY_HINT_RE = /\b(current|active|selected|focus(?:ed)?|edit(?:ing)?)\b/i;
const MEMOQ_ACTIVE_CELL_SELECTORS = [
  `${MEMOQ_CELL_SELECTOR}:focus-within`,
  `${MEMOQ_CELL_SELECTOR}[aria-selected="true"]`,
  `${MEMOQ_CELL_SELECTOR}[aria-current="true"]`,
  `${MEMOQ_CELL_SELECTOR}.current`,
  `${MEMOQ_CELL_SELECTOR}.active`,
  `${MEMOQ_CELL_SELECTOR}.selected`,
  `${MEMOQ_CELL_SELECTOR}[class*="current"]`,
  `${MEMOQ_CELL_SELECTOR}[class*="active"]`,
  `${MEMOQ_CELL_SELECTOR}[class*="selected"]`
];

type MemoqLiveEditorKind = 'input' | 'contenteditable' | 'hiddenRelay';
type MemoqEditorSource = 'activeElement' | 'hiddenRelay';

interface MemoqLiveEditor {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  kind: MemoqLiveEditorKind;
  source: MemoqEditorSource;
  signature: string;
}

export interface MemoqScanObservation {
  visibleCellCount: number;
  visibleRowCount: number;
  extractedSegmentCount: number;
}

export interface MemoqConfirmationObservation {
  expectedValue: string;
  editorValue: string;
  targetValue: string;
}

export interface MemoqFillViewportRow {
  rowElement: HTMLElement;
  segment: RuntimeSegment;
  rowFingerprint: string;
}

export interface MemoqFillViewport {
  rows: MemoqFillViewportRow[];
  signature: string;
}

export interface MemoqFillCursorState {
  viewportIndex: number;
  rowFingerprint: string;
}

export interface MemoqFillStartResult {
  cursorState: MemoqFillCursorState;
  segment: RuntimeSegment;
}

export interface MemoqFillAdvanceResult {
  viewport: MemoqFillViewport;
  cursorState: MemoqFillCursorState | null;
  segment: RuntimeSegment | null;
  reachedEnd: boolean;
}

interface MemoqTextSnapshot {
  raw: string;
  canonical: string;
}

interface MemoqConfirmationSnapshotObservation {
  expected: MemoqTextSnapshot;
  editor: MemoqTextSnapshot;
  target: MemoqTextSnapshot;
}

export function canonicalizeMemoqText(value: string): string {
  return normalizeText(
    value
      .replace(MEMOQ_ZERO_WIDTH_RE, '')
      .replace(MEMOQ_NON_BREAKING_SPACE_RE, ' ')
      .replace(MEMOQ_RENDER_SEPARATOR_RE, ' ')
  );
}

export function buildMemoqStableSegmentId(
  sourceNormalized: string,
  absoluteTop: number
): string {
  return `${sourceNormalized}::${Math.round(absoluteTop / VISIBLE_SEGMENT_TOP_BUCKET_PX)}`;
}

export function buildMemoqSegmentFingerprint(
  sourceNormalized: string,
  absoluteTop: number,
  targetRaw: string
): string {
  return `${buildMemoqStableSegmentId(sourceNormalized, absoluteTop)}::${canonicalizeMemoqText(
    targetRaw
  )}`;
}

function createMemoqTextSnapshot(value: string): MemoqTextSnapshot {
  const raw = normalizeText(value);
  return {
    raw,
    canonical: canonicalizeMemoqText(raw)
  };
}

function evaluateMemoqConfirmationSnapshot(
  observation: MemoqConfirmationSnapshotObservation
): {
  confirmed: boolean;
  reason?: string;
} {
  if (observation.target.canonical === observation.expected.canonical) {
    return {
      confirmed: true
    };
  }

  if (observation.editor.canonical === observation.expected.canonical) {
    return {
      confirmed: false,
      reason: 'memoQ editor accepted the value, but the target cell did not commit the update.'
    };
  }

  if (observation.editor.canonical.length > 0) {
    return {
      confirmed: false,
      reason: 'memoQ editor shows a different value after writing.'
    };
  }

  return {
    confirmed: false,
    reason: 'memoQ editor did not reflect the requested value.'
  };
}

export function buildMemoqScanFailureReason(observation: MemoqScanObservation): string {
  if (observation.visibleCellCount === 0) {
    return 'memoQ scan could not find visible editor cells.';
  }

  if (observation.visibleRowCount === 0) {
    return 'memoQ scan found editor cells, but could not group them into source/target rows.';
  }

  return 'memoQ scan found rows, but could not extract any source/target segment pairs.';
}

export function evaluateMemoqConfirmation(
  observation: MemoqConfirmationObservation
): {
  confirmed: boolean;
  reason?: string;
} {
  return evaluateMemoqConfirmationSnapshot({
    expected: createMemoqTextSnapshot(observation.expectedValue),
    editor: createMemoqTextSnapshot(observation.editorValue),
    target: createMemoqTextSnapshot(observation.targetValue)
  });
}

export function buildMemoqFillRowFingerprint(
  sourceRaw: string,
  sourceNormalized: string,
  targetRaw: string
): string {
  return [
    sourceNormalized,
    canonicalizeMemoqText(sourceRaw),
    canonicalizeMemoqText(targetRaw)
  ].join('\u001F');
}

export function buildMemoqFillViewportSignature(
  rowFingerprints: readonly string[]
): string {
  return rowFingerprints.join('\u001E');
}

export function findMemoqFillViewportOverlap(
  previousFingerprints: readonly string[],
  nextFingerprints: readonly string[]
): number {
  const maxOverlap = Math.min(previousFingerprints.length, nextFingerprints.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;

    for (let index = 0; index < overlap; index += 1) {
      if (
        previousFingerprints[previousFingerprints.length - overlap + index] !==
        nextFingerprints[index]
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return overlap;
    }
  }

  return 0;
}

export function detectStableMemoqFillViewport(
  signatures: readonly string[],
  stableViewportCount = MEMOQ_CURSOR_END_PROBE_COUNT
): boolean {
  if (signatures.length < stableViewportCount) {
    return false;
  }

  const recentSignatures = signatures.slice(-stableViewportCount);
  const firstSignature = recentSignatures[0];

  return recentSignatures.every((signature) => signature === firstSignature);
}

export class MemoqAdapter {
  private lastScanObservation: MemoqScanObservation = {
    visibleCellCount: 0,
    visibleRowCount: 0,
    extractedSegmentCount: 0
  };
  private lastSyntheticScrollTarget: HTMLElement | null = null;

  constructor(private readonly helpers: ContentScriptDomHelpers) {
    this.bindInteractionTracking();
  }

  isActive(): boolean {
    return document.querySelector(MEMOQ_CELL_SELECTOR) !== null;
  }

  getLastScanObservation(): MemoqScanObservation {
    return {
      ...this.lastScanObservation
    };
  }

  buildScanFailureReason(): string {
    return buildMemoqScanFailureReason(this.lastScanObservation);
  }

  findScrollContext(diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS): ScrollContext | null {
    const cells = this.getVisibleCells();
    const bestContainer = this.helpers.findBestScrollContainer(cells);
    const memoqContainer = bestContainer ?? this.findMemoqScrollContainer(cells);

    if (memoqContainer) {
      this.lastSyntheticScrollTarget = null;
      diagnostics.info('scroll-context', 'Using a native memoQ scroll container.', {
        container: this.describeElement(memoqContainer),
        visibleCellCount: cells.length
      });
      return this.helpers.toElementScrollContext(memoqContainer);
    }

    const interactionTarget = this.findMemoqInteractionTarget(cells);
    if (!interactionTarget) {
      diagnostics.error('scroll-context', 'Could not resolve a memoQ interaction target.', {
        visibleCellCount: cells.length
      });
      return null;
    }

    diagnostics.warn('scroll-context', 'Falling back to a synthetic memoQ scroll context.', {
      interactionTarget: this.describeElement(interactionTarget),
      visibleCellCount: cells.length
    });
    this.lastSyntheticScrollTarget = interactionTarget;
    return this.createSyntheticScrollContext(interactionTarget);
  }

  captureMemoqFillViewport(
    scrollContext: ScrollContext,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): MemoqFillViewport {
    const rows = this.collectVisibleRows(scrollContext).flatMap((rowElement) => {
      const segment = this.extractMemoqSegment(rowElement, scrollContext);
      if (!segment) {
        return [];
      }

      return [
        {
          rowElement,
          segment,
          rowFingerprint: buildMemoqFillRowFingerprint(
            segment.sourceRaw,
            segment.sourceNormalized,
            segment.targetRaw
          )
        }
      ];
    });
    const signature = buildMemoqFillViewportSignature(
      rows.map((row) => row.rowFingerprint)
    );

    diagnostics.info('navigate', 'Captured memoQ fill viewport.', {
      visibleRows: rows.length,
      signature
    });

    return {
      rows,
      signature
    };
  }

  resolveMemoqFillStart(
    viewport: MemoqFillViewport,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): MemoqFillStartResult | null {
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const strategies: Array<{
      name: string;
      index: number | null;
      details?: Record<string, unknown>;
    }> = [
      {
        name: 'marked',
        index: this.findMarkedMemoqFillStartIndex(viewport)
      },
      {
        name: 'tracked',
        index: this.findTrackedMemoqFillStartIndex(viewport),
        details: {
          trackedRow: this.describeElement(window.__memoqTrackedRow),
          trackedCell: this.describeElement(window.__memoqTrackedCell)
        }
      },
      {
        name: 'hiddenRelay',
        index: this.findRelayMatchedMemoqFillStartIndex(viewport),
        details: {
          hiddenRelay: this.describeElement(this.findHiddenRelayInput())
        }
      }
    ];

    for (const strategy of strategies) {
      if (strategy.index === null) {
        continue;
      }

      const cursorState = this.createMemoqFillCursorState(viewport, strategy.index);
      if (!cursorState) {
        continue;
      }

      const row = viewport.rows[strategy.index];
      this.rememberMemoqRow(row.rowElement, row.segment.targetElement as HTMLElement);
      diagnostics.info('navigate', 'Resolved the memoQ fill start row.', {
        strategy: strategy.name,
        index: strategy.index,
        rowFingerprint: row.rowFingerprint,
        row: this.describeElement(row.rowElement),
        activeElement: this.describeElement(activeElement),
        ...strategy.details
      });

      return {
        cursorState,
        segment: row.segment
      };
    }

    diagnostics.warn('navigate', 'Could not uniquely resolve the memoQ fill start row.', {
      activeElement: this.describeElement(activeElement),
      hiddenRelay: this.describeElement(this.findHiddenRelayInput()),
      visibleRows: viewport.rows.length
    });
    return null;
  }

  updateMemoqFillViewportRow(
    viewport: MemoqFillViewport,
    cursorState: MemoqFillCursorState,
    targetRaw: string
  ): MemoqFillViewport {
    const currentRow = viewport.rows[cursorState.viewportIndex];
    if (!currentRow) {
      return viewport;
    }

    const updatedRows = viewport.rows.map((row, index) => {
      if (index !== cursorState.viewportIndex) {
        return row;
      }

      const segment = {
        ...row.segment,
        targetRaw,
        isEmptyTarget: canonicalizeMemoqText(targetRaw) === ''
      };

      return {
        ...row,
        segment,
        rowFingerprint: buildMemoqFillRowFingerprint(
          segment.sourceRaw,
          segment.sourceNormalized,
          segment.targetRaw
        )
      };
    });

    return this.buildMemoqFillViewport(updatedRows);
  }

  async advanceMemoqFillCursor(
    cursorState: MemoqFillCursorState,
    viewport: MemoqFillViewport,
    scrollContext: ScrollContext,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): Promise<MemoqFillAdvanceResult> {
    const inViewportNextIndex = cursorState.viewportIndex + 1;
    if (inViewportNextIndex < viewport.rows.length) {
      const nextCursorState = this.createMemoqFillCursorState(viewport, inViewportNextIndex);
      const nextSegment = viewport.rows[inViewportNextIndex]?.segment ?? null;

      return {
        viewport,
        cursorState: nextCursorState,
        segment: nextSegment,
        reachedEnd: nextCursorState === null || nextSegment === null
      };
    }

    let workingViewport = viewport;
    const signatures = [viewport.signature];

    for (let attempt = 0; attempt < MEMOQ_CURSOR_PROBE_ATTEMPTS; attempt += 1) {
      await this.scrollMemoqFillViewportForward(scrollContext, diagnostics);
      const nextViewport = this.captureMemoqFillViewport(scrollContext, diagnostics);
      signatures.push(nextViewport.signature);

      if (detectStableMemoqFillViewport(signatures)) {
        diagnostics.info('navigate', 'Detected the end of the memoQ flow from a stable viewport signature.', {
          attempt: attempt + 1,
          signature: nextViewport.signature
        });
        return {
          viewport: nextViewport,
          cursorState: null,
          segment: null,
          reachedEnd: true
        };
      }

      if (nextViewport.rows.length === 0) {
        workingViewport = nextViewport;
        continue;
      }

      const overlap = findMemoqFillViewportOverlap(
        workingViewport.rows.map((row) => row.rowFingerprint),
        nextViewport.rows.map((row) => row.rowFingerprint)
      );
      const nextIndex = overlap;

      diagnostics.info('navigate', 'Advanced the memoQ fill viewport cursor.', {
        attempt: attempt + 1,
        previousSignature: workingViewport.signature,
        nextSignature: nextViewport.signature,
        overlap,
        nextIndex,
        nextVisibleRows: nextViewport.rows.length
      });

      if (nextIndex < nextViewport.rows.length) {
        const nextCursorState = this.createMemoqFillCursorState(nextViewport, nextIndex);
        const nextSegment = nextViewport.rows[nextIndex]?.segment ?? null;

        return {
          viewport: nextViewport,
          cursorState: nextCursorState,
          segment: nextSegment,
          reachedEnd: nextCursorState === null || nextSegment === null
        };
      }

      workingViewport = nextViewport;
    }

    diagnostics.warn('navigate', 'memoQ fill viewport could not advance after repeated scroll attempts; stopping cleanly.', {
      attempts: MEMOQ_CURSOR_PROBE_ATTEMPTS,
      signature: workingViewport.signature
    });
    return {
      viewport: workingViewport,
      cursorState: null,
      segment: null,
      reachedEnd: true
    };
  }

  async scrollMemoqFillViewportForward(
    scrollContext: ScrollContext,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): Promise<void> {
    const delta = this.getCursorScrollStep(scrollContext);

    if (scrollContext.mode !== 'synthetic') {
      scrollContext.scrollBy(delta);
      await delay(MEMOQ_CURSOR_NAVIGATION_DELAY_MS);
      return;
    }

    const target =
      this.lastSyntheticScrollTarget ?? this.findMemoqInteractionTarget(this.getVisibleCells());
    if (!target) {
      diagnostics.warn('navigate', 'Could not resolve a synthetic memoQ scroll target while advancing fill.', {
        delta
      });
      await delay(MEMOQ_CURSOR_NAVIGATION_DELAY_MS);
      return;
    }

    const hiddenRelay = this.findHiddenRelayInput();
    const focusTarget =
      (hiddenRelay && !hiddenRelay.disabled && !hiddenRelay.readOnly
        ? hiddenRelay
        : null) ||
      target.querySelector<HTMLElement>(MEMOQ_CELL_SELECTOR) ||
      target;

    focusTarget.focus();

    const receivers = new Set<HTMLElement | HTMLInputElement>([
      focusTarget,
      target
    ]);
    if (target.parentElement) {
      receivers.add(target.parentElement);
    }

    for (const receiver of receivers) {
      receiver.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: delta
        })
      );
    }

    diagnostics.info('navigate', 'Scrolled the synthetic memoQ fill viewport forward.', {
      delta,
      interactionTarget: this.describeElement(target),
      focusTarget: this.describeElement(focusTarget)
    });
    await delay(MEMOQ_CURSOR_NAVIGATION_DELAY_MS);
  }

  collectVisibleSegments(
    scrollContext: ScrollContext,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): RuntimeSegment[] {
    const visibleCellCount = this.getVisibleCells().length;
    if (visibleCellCount === 0) {
      this.lastScanObservation = {
        visibleCellCount: 0,
        visibleRowCount: 0,
        extractedSegmentCount: 0
      };
      diagnostics.warn('scan', 'No visible memoQ editor cells were found in this pass.');
      return [];
    }

    const visibleRows = this.collectVisibleRows(scrollContext);
    const segments = this.filterPhantomSegments(
      this.dedupeVisibleSegments(
        visibleRows.flatMap((row) => {
          const segment = this.extractMemoqSegment(row, scrollContext);
          return segment ? [segment] : [];
        })
      )
    );
    this.lastScanObservation = {
      visibleCellCount,
      visibleRowCount: visibleRows.length,
      extractedSegmentCount: segments.length
    };

    diagnostics.info('scan', 'Collected visible memoQ segments.', {
      ...this.lastScanObservation
    });

    return segments;
  }

  getEditableValue(targetElement: HTMLElement): string {
    return this.getCellTextSnapshot(targetElement).raw;
  }

  async fillSegment(
    segment: RuntimeSegment,
    value: string,
    diagnostics: MemoqDiagnostics = NOOP_MEMOQ_DIAGNOSTICS
  ): Promise<FillOutcome> {
    const target = segment.targetElement as HTMLElement;
    const previousActiveElement = document.activeElement;

    diagnostics.info('activate-target', 'Activating memoQ target segment.', {
      domId: segment.domId,
      target: this.describeElement(target)
    });
    await this.activateTarget(target, diagnostics);

    const liveEditor = this.resolveLiveEditor(target, previousActiveElement, diagnostics);
    if (!liveEditor) {
      const reason = 'memoQ did not expose a writable live editor for the selected segment.';
      diagnostics.error('editor-resolve', reason, {
        domId: segment.domId,
        target: this.describeElement(target),
        activeElement: this.describeElement(document.activeElement)
      });
      return {
        domId: segment.domId,
        filled: false,
        reason
      };
    }

    const targetBefore = this.getCellTextSnapshot(target);
    const editorBefore = this.getLiveEditorTextSnapshot(liveEditor);
    diagnostics.info('write', 'Writing translation into memoQ live editor.', {
      domId: segment.domId,
      editorKind: liveEditor.kind,
      editorSource: liveEditor.source,
      editor: liveEditor.signature,
      targetBefore: targetBefore.raw,
      targetBeforeCanonical: targetBefore.canonical,
      editorBefore: editorBefore.raw,
      editorBeforeCanonical: editorBefore.canonical
    });

    this.writeAndCommit(liveEditor, value);

    const confirmation = await this.confirmWrite(target, liveEditor, value, diagnostics);
    if (!confirmation.confirmed) {
      diagnostics.warn(
        'confirm',
        confirmation.reason ?? 'Unable to confirm memoQ target update.',
        {
          domId: segment.domId,
          editorKind: liveEditor.kind,
          editorSource: liveEditor.source,
          editor: liveEditor.signature
        }
      );
    }

    return {
      domId: segment.domId,
      filled: confirmation.confirmed,
      reason: confirmation.reason
    };
  }

  private getVisibleCells(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR)).filter((cell) =>
      this.helpers.isElementVisible(cell)
    );
  }

  private findMemoqRowContainer(cell: HTMLElement): HTMLElement | null {
    let cursor: HTMLElement | null = cell.parentElement;

    while (cursor && cursor !== document.body) {
      const editorCellCount = cursor.querySelectorAll(MEMOQ_CELL_SELECTOR).length;
      if (editorCellCount >= 2) {
        return cursor;
      }

      cursor = cursor.parentElement;
    }

    return null;
  }

  private collectVisibleRows(scrollContext: ScrollContext): HTMLElement[] {
    const rows = new Set<HTMLElement>();

    for (const cell of this.helpers.sortByVisualPosition(this.getVisibleCells(), scrollContext)) {
      const row = this.findMemoqRowContainer(cell);
      if (row) {
        rows.add(row);
      }
    }

    return this.helpers.sortByVisualPosition([...rows], scrollContext);
  }

  private bindInteractionTracking(): void {
    if (window.__memoqInteractionTrackingBound) {
      return;
    }

    const trackInteraction = (event: Event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) {
        return;
      }

      const cell = target.closest<HTMLElement>(MEMOQ_CELL_SELECTOR);
      if (!cell || !this.helpers.isElementVisible(cell)) {
        return;
      }

      const row = this.findMemoqRowContainer(cell);
      if (!row) {
        return;
      }

      this.rememberMemoqRow(row, cell);
    };

    document.addEventListener('pointerdown', trackInteraction, true);
    document.addEventListener('focusin', trackInteraction, true);
    window.__memoqInteractionTrackingBound = true;
  }

  private rememberMemoqRow(row: HTMLElement, cell?: HTMLElement | null): void {
    window.__memoqTrackedRow = row;
    window.__memoqTrackedCell = cell ?? null;
  }

  private buildMemoqFillViewport(rows: MemoqFillViewportRow[]): MemoqFillViewport {
    return {
      rows,
      signature: buildMemoqFillViewportSignature(rows.map((row) => row.rowFingerprint))
    };
  }

  private createMemoqFillCursorState(
    viewport: MemoqFillViewport,
    viewportIndex: number
  ): MemoqFillCursorState | null {
    const row = viewport.rows[viewportIndex];
    if (!row) {
      return null;
    }

    return {
      viewportIndex,
      rowFingerprint: row.rowFingerprint
    };
  }

  private findViewportIndexContainingElement(
    viewport: MemoqFillViewport,
    element: HTMLElement | null | undefined
  ): number | null {
    if (!element) {
      return null;
    }

    const matchingIndexes = viewport.rows.flatMap((row, index) =>
      row.rowElement.contains(element) ? [index] : []
    );

    return matchingIndexes.length === 1 ? matchingIndexes[0] : null;
  }

  private findMarkedMemoqFillStartIndex(viewport: MemoqFillViewport): number | null {
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeIndex =
      activeElement && !this.isHiddenRelayElement(activeElement)
        ? this.findViewportIndexContainingElement(viewport, activeElement)
        : null;
    if (activeIndex !== null) {
      return activeIndex;
    }

    const selectedCell = this.findSelectedMemoqCell();
    const selectedIndex = this.findViewportIndexContainingElement(viewport, selectedCell);
    if (selectedIndex !== null) {
      return selectedIndex;
    }

    let bestCandidate: { index: number; score: number } | null = null;
    let secondBestScore = -1;

    for (const [index, row] of viewport.rows.entries()) {
      const score = this.scoreMemoqExplicitRowActivity(
        row.rowElement,
        row.segment.targetElement as HTMLElement
      );
      if (score <= 0) {
        continue;
      }

      if (!bestCandidate || score > bestCandidate.score) {
        secondBestScore = bestCandidate?.score ?? -1;
        bestCandidate = {
          index,
          score
        };
        continue;
      }

      if (score > secondBestScore) {
        secondBestScore = score;
      }
    }

    if (!bestCandidate || bestCandidate.score === secondBestScore) {
      return null;
    }

    return bestCandidate.index;
  }

  private findTrackedMemoqFillStartIndex(viewport: MemoqFillViewport): number | null {
    const trackedRowIndex = this.findViewportIndexContainingElement(
      viewport,
      window.__memoqTrackedRow
    );
    if (trackedRowIndex !== null) {
      return trackedRowIndex;
    }

    return this.findViewportIndexContainingElement(viewport, window.__memoqTrackedCell);
  }

  private scoreMemoqExplicitRowActivity(
    row: HTMLElement,
    targetCell: HTMLElement | null
  ): number {
    let score = 0;
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const candidates = [row, targetCell].filter((value): value is HTMLElement => Boolean(value));

    for (const candidate of candidates) {
      if (
        candidate.matches('[aria-selected="true"], [aria-current="true"]') ||
        candidate.getAttribute('data-selected') === 'true'
      ) {
        score += 8;
      }

      const classText = [candidate.className, candidate.getAttribute('data-state') ?? '']
        .filter(Boolean)
        .join(' ');
      if (MEMOQ_ACTIVITY_HINT_RE.test(classText)) {
        score += 4;
      }

      if (activeElement && !this.isHiddenRelayElement(activeElement) && candidate.contains(activeElement)) {
        score += 6;
      }
    }

    return score;
  }

  private findRelayMatchedMemoqFillStartIndex(viewport: MemoqFillViewport): number | null {
    const hiddenRelay = this.findHiddenRelayInput();
    if (!hiddenRelay || hiddenRelay.disabled || hiddenRelay.readOnly) {
      return null;
    }

    const relayValue = canonicalizeMemoqText(hiddenRelay.value ?? '');
    if (!relayValue) {
      return null;
    }

    const matchingIndexes = viewport.rows.flatMap((row, index) =>
      canonicalizeMemoqText(row.segment.targetRaw) === relayValue ? [index] : []
    );

    return matchingIndexes.length === 1 ? matchingIndexes[0] : null;
  }

  private findSelectedMemoqCell(): HTMLElement | null {
    for (const selector of MEMOQ_ACTIVE_CELL_SELECTORS) {
      const cell = document.querySelector<HTMLElement>(selector);
      if (cell && this.helpers.isElementVisible(cell)) {
        return cell;
      }
    }

    return null;
  }

  private getRowCells(row: HTMLElement, scrollContext: ScrollContext): HTMLElement[] {
    return this.helpers.sortByVisualPosition(
      Array.from(row.querySelectorAll<HTMLElement>(MEMOQ_CELL_SELECTOR)).filter((cell) =>
        this.helpers.isElementVisible(cell)
      ),
      scrollContext
    );
  }

  private getRowTargetCell(row: HTMLElement, scrollContext: ScrollContext): HTMLElement | null {
    const cells = this.getRowCells(row, scrollContext);
    return cells.length >= 2 ? cells[cells.length - 1] : null;
  }

  private getCursorScrollStep(scrollContext: ScrollContext): number {
    const proportionalStep = scrollContext.getHeight() * MEMOQ_CURSOR_SCROLL_RATIO;
    return Math.min(
      MEMOQ_CURSOR_SCROLL_MAX_PX,
      Math.max(MEMOQ_CURSOR_SCROLL_MIN_PX, proportionalStep)
    );
  }

  private extractMemoqSegment(
    row: HTMLElement,
    scrollContext: ScrollContext
  ): RuntimeSegment | null {
    const cells = this.getRowCells(row, scrollContext);

    if (cells.length < 2) {
      return null;
    }

    const sourceCell = cells[0];
    const targetCell = cells[cells.length - 1];
    const sourceRaw = this.getCellTextSnapshot(sourceCell).raw;
    const sourceNormalized = normalizeText(sourceRaw);

    if (!sourceNormalized) {
      return null;
    }

    const targetSnapshot = this.getCellTextSnapshot(targetCell);
    const targetRaw = targetSnapshot.raw;
    const absoluteTop = this.helpers.getAbsoluteTop(row, scrollContext);
    const domId = buildMemoqStableSegmentId(sourceNormalized, absoluteTop);

    return {
      domId,
      sourceRaw,
      sourceNormalized,
      occurrenceIndex: 0,
      targetRaw,
      isEmptyTarget: targetSnapshot.canonical === '',
      placeholderTokens: extractPlaceholderTokens(sourceRaw),
      targetElement: targetCell,
      platform: 'memoq',
      scanElement: row,
      scanFingerprint: buildMemoqSegmentFingerprint(sourceNormalized, absoluteTop, targetRaw)
    };
  }

  private dedupeVisibleSegments(segments: RuntimeSegment[]): RuntimeSegment[] {
    const deduped = new Map<string, RuntimeSegment>();

    for (const segment of segments) {
      const current = deduped.get(segment.domId);

      if (!current) {
        deduped.set(segment.domId, segment);
        continue;
      }

      const currentTarget = canonicalizeMemoqText(current.targetRaw);
      const nextTarget = canonicalizeMemoqText(segment.targetRaw);
      const shouldReplace = currentTarget.length === 0 && nextTarget.length > 0;

      if (shouldReplace) {
        deduped.set(segment.domId, segment);
      }
    }

    return [...deduped.values()];
  }

  private filterPhantomSegments(segments: RuntimeSegment[]): RuntimeSegment[] {
    const fingerprints = new Set<string>();
    const filtered: RuntimeSegment[] = [];

    for (const segment of segments) {
      const fingerprint = segment.scanFingerprint ?? segment.domId;
      if (fingerprints.has(fingerprint)) {
        continue;
      }

      fingerprints.add(fingerprint);
      filtered.push(segment);
    }

    return filtered;
  }

  private resolveLiveEditor(
    targetElement: HTMLElement,
    previousActiveElement: Element | null,
    diagnostics: MemoqDiagnostics
  ): MemoqLiveEditor | null {
    const row = this.findMemoqRowContainer(targetElement);
    const activeEditor = this.toActiveLiveEditor(
      document.activeElement,
      targetElement,
      row,
      previousActiveElement
    );
    if (activeEditor) {
      diagnostics.info('editor-resolve', 'Resolved memoQ live editor from the active element.', {
        editorKind: activeEditor.kind,
        editorSource: activeEditor.source,
        editor: activeEditor.signature
      });
      return activeEditor;
    }

    const hiddenRelay = this.findHiddenRelayInput();
    if (hiddenRelay && !hiddenRelay.disabled && !hiddenRelay.readOnly) {
      const editor: MemoqLiveEditor = {
        element: hiddenRelay,
        kind: 'hiddenRelay',
        source: 'hiddenRelay',
        signature: this.describeElement(hiddenRelay)
      };
      diagnostics.info('editor-resolve', 'Resolved memoQ hidden relay editor.', {
        editorKind: editor.kind,
        editorSource: editor.source,
        editor: editor.signature
      });
      return editor;
    }

    return null;
  }

  private toActiveLiveEditor(
    candidate: Element | null,
    targetElement: HTMLElement,
    row: HTMLElement | null,
    previousActiveElement: Element | null
  ): MemoqLiveEditor | null {
    if (!candidate) {
      return null;
    }

    if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
      if (this.isHiddenRelayCandidate(candidate)) {
        return null;
      }

      if (candidate.disabled || candidate.readOnly) {
        return null;
      }

      if (
        !this.isActivatedRowEditorCandidate(
          candidate,
          targetElement,
          row,
          previousActiveElement
        )
      ) {
        return null;
      }

      return {
        element: candidate,
        kind: 'input',
        source: 'activeElement',
        signature: this.describeElement(candidate)
      };
    }

    if (
      candidate instanceof HTMLElement &&
      candidate.isContentEditable &&
      this.isActivatedRowEditorCandidate(candidate, targetElement, row, previousActiveElement)
    ) {
      return {
        element: candidate,
        kind: 'contenteditable',
        source: 'activeElement',
        signature: this.describeElement(candidate)
      };
    }

    return null;
  }

  private isActivatedRowEditorCandidate(
    candidate: HTMLElement,
    targetElement: HTMLElement,
    row: HTMLElement | null,
    previousActiveElement: Element | null
  ): boolean {
    if (
      candidate === previousActiveElement &&
      !targetElement.contains(candidate) &&
      !row?.contains(candidate)
    ) {
      return false;
    }

    return targetElement.contains(candidate) || row?.contains(candidate) === true;
  }

  private writeAndCommit(editor: MemoqLiveEditor, value: string): void {
    if (editor.kind === 'contenteditable') {
      editor.element.focus();
      this.helpers.setEditableValue(editor.element, value);
      this.helpers.dispatchInput(editor.element, value, true);
      this.helpers.dispatchBlur(editor.element);
      return;
    }

    const input = editor.element as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    this.helpers.setNativeInputValue(input, value);
    this.helpers.dispatchInput(input, value, true);
    this.helpers.dispatchChange(input);

    if (editor.kind === 'hiddenRelay') {
      this.helpers.dispatchTabNavigation(input);
    }

    this.helpers.dispatchBlur(input);
  }

  private async confirmWrite(
    targetElement: HTMLElement,
    editor: MemoqLiveEditor,
    expectedValue: string,
    diagnostics: MemoqDiagnostics
  ): Promise<{
    confirmed: boolean;
    reason?: string;
  }> {
    const expectedSnapshot = createMemoqTextSnapshot(expectedValue);
    let result = evaluateMemoqConfirmationSnapshot({
      expected: expectedSnapshot,
      editor: createMemoqTextSnapshot(''),
      target: createMemoqTextSnapshot('')
    });

    for (let attempt = 0; attempt < MEMOQ_CONFIRM_ATTEMPTS; attempt += 1) {
      const targetSnapshot = this.getCellTextSnapshot(targetElement);
      const editorSnapshot = this.getLiveEditorTextSnapshot(editor);
      result = evaluateMemoqConfirmationSnapshot({
        expected: expectedSnapshot,
        editor: editorSnapshot,
        target: targetSnapshot
      });

      diagnostics.info('confirm', 'Observed memoQ confirmation snapshot.', {
        attempt: attempt + 1,
        confirmed: result.confirmed,
        expectedValue: expectedSnapshot.raw,
        expectedCanonical: expectedSnapshot.canonical,
        targetValue: targetSnapshot.raw,
        targetCanonical: targetSnapshot.canonical,
        editorValue: editorSnapshot.raw,
        editorCanonical: editorSnapshot.canonical
      });

      if (result.confirmed) {
        return result;
      }

      if (attempt < MEMOQ_CONFIRM_ATTEMPTS - 1) {
        await delay(MEMOQ_CONFIRM_DELAY_MS);
      }
    }

    return result;
  }

  private getCellTextSnapshot(cellElement: HTMLElement): MemoqTextSnapshot {
    const content = cellElement.querySelector<HTMLElement>(MEMOQ_CONTENT_SELECTOR) || cellElement;
    return createMemoqTextSnapshot(content.innerText || content.textContent || '');
  }

  private getLiveEditorTextSnapshot(editor: MemoqLiveEditor): MemoqTextSnapshot {
    if (editor.kind === 'contenteditable') {
      return createMemoqTextSnapshot(editor.element.textContent ?? '');
    }

    return createMemoqTextSnapshot(
      (editor.element as HTMLInputElement | HTMLTextAreaElement).value ?? ''
    );
  }

  private isHiddenRelayCandidate(element: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    return MEMOQ_HIDDEN_RELAY_SELECTORS.some((selector) => element.matches(selector));
  }

  private isHiddenRelayElement(element: HTMLElement): boolean {
    return (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      this.isHiddenRelayCandidate(element)
    );
  }

  private findHiddenRelayInput(): HTMLInputElement | null {
    for (const selector of MEMOQ_HIDDEN_RELAY_SELECTORS) {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (input) {
        return input;
      }
    }

    return null;
  }

  private findMemoqScrollContainer(cells: HTMLElement[]): HTMLElement | null {
    if (cells.length === 0) {
      return null;
    }

    const candidateContainers = new Map<
      HTMLElement,
      { score: number; scrollRange: number }
    >();

    for (const cell of cells.slice(0, 40)) {
      let ancestor = cell.parentElement;
      let depth = 0;

      while (ancestor && ancestor !== document.body && depth < 12) {
        const scrollRange = ancestor.scrollHeight - ancestor.clientHeight;
        if (scrollRange > 120) {
          const current = candidateContainers.get(ancestor) ?? {
            score: 0,
            scrollRange
          };
          current.score += Math.max(1, 10 - depth);
          current.scrollRange = Math.max(current.scrollRange, scrollRange);

          const style = window.getComputedStyle(ancestor);
          if (style.overflowY !== 'visible') {
            current.score += 2;
          }

          if (ancestor.querySelectorAll(MEMOQ_CELL_SELECTOR).length > 20) {
            current.score += 3;
          }

          candidateContainers.set(ancestor, current);
        }

        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidateContainers.entries()]
      .sort((left, right) => {
        if (right[1].score !== left[1].score) {
          return right[1].score - left[1].score;
        }

        return right[1].scrollRange - left[1].scrollRange;
      })[0]?.[0] ?? null;
  }

  private findMemoqInteractionTarget(cells: HTMLElement[]): HTMLElement | null {
    const candidates = new Map<HTMLElement, number>();

    for (const cell of cells.slice(0, 40)) {
      let ancestor = cell.parentElement;
      let depth = 0;

      while (ancestor && ancestor !== document.body && depth < 8) {
        const current = candidates.get(ancestor) ?? 0;
        candidates.set(ancestor, current + Math.max(1, 8 - depth));
        ancestor = ancestor.parentElement;
        depth += 1;
      }
    }

    return [...candidates.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }

  private createSyntheticScrollContext(target: HTMLElement): ScrollContext {
    let syntheticTop = 0;

    return {
      initialTop: 0,
      mode: 'synthetic',
      getTop: () => syntheticTop,
      getHeight: () => target.clientHeight || window.innerHeight,
      scrollBy: (delta) => {
        const hiddenInput = this.findHiddenRelayInput();
        const focusTarget =
          hiddenInput ||
          target.querySelector<HTMLElement>(MEMOQ_CELL_SELECTOR) ||
          target;

        focusTarget.focus();

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: Math.max(delta, 240)
            })
          );
        }

        for (const receiver of [focusTarget, target]) {
          receiver.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
          receiver.dispatchEvent(
            new KeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'PageDown',
              code: 'PageDown'
            })
          );
        }

        syntheticTop += Math.max(delta, 240);
      },
      isAtBottom: () => false,
      restore: () => {
        // Synthetic scrolling cannot be restored reliably.
      }
    };
  }

  private async activateTarget(
    targetElement: HTMLElement,
    diagnostics: MemoqDiagnostics
  ): Promise<void> {
    const clickTarget =
      targetElement.querySelector<HTMLElement>(MEMOQ_CONTENT_SELECTOR) || targetElement;

    this.helpers.dispatchMouseSequence(clickTarget, [
      'mousedown',
      'mouseup',
      'click',
      'dblclick'
    ]);
    clickTarget.focus();
    await delay(MEMOQ_ACTIVATION_DELAY_MS);

    diagnostics.info('activate-target', 'memoQ target activation settled.', {
      target: this.describeElement(clickTarget),
      activeElement: this.describeElement(document.activeElement)
    });
  }

  private describeElement(element: Element | null | undefined): string {
    if (!element) {
      return '(none)';
    }

    const id = element.id ? `#${element.id}` : '';
    const className =
      element instanceof HTMLElement
        ? Array.from(element.classList)
            .slice(0, 3)
            .map((value) => `.${value}`)
            .join('')
        : '';

    return `${element.tagName.toLowerCase()}${id}${className}`;
  }
}
