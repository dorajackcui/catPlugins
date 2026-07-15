import {
  findMemoqStartTargetCell,
  readMemoqStartMarkerDomId
} from '../platforms/memoq/dom-profile.ts';
import type { StartMarker } from './start-marker.ts';

export const START_MARKER_MAX_AGE_MS = 30 * 60 * 1000;

const GIENTRANS_START_TARGET_SELECTOR =
  'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_START_TARGET_CELL_SELECTOR = 'td.target-cell';
const PHRASE_START_TARGET_SELECTOR = '.twe_target';
const PHRASE_ROW_SELECTOR = '.segment-row[role="row"], .segment-row, .twe_segment';
const EDITOR_SURFACE_SELECTOR =
  '#o-editor.online-editor, .editor__table, .segment-row, .twe_segment';

declare global {
  interface Window {
    __phraseBulkFillStartMarker?: StartMarker;
    __phraseBulkFillStartMarkerBound?: boolean;
  }
}

export interface StartMarkerState {
  marker?: StartMarker;
  listenersBound?: boolean;
}

export interface StartMarkerEnvironment {
  document: Document;
  state: StartMarkerState;
  now(): number;
  isElement(value: EventTarget | null): value is Element;
}

export function bindStartMarkerListeners(
  environment: StartMarkerEnvironment = createBrowserEnvironment()
): void {
  if (environment.state.listenersBound) {
    return;
  }

  const remember = (event: Event): void => {
    rememberStartMarkerFromEvent(event, environment);
  };
  for (const eventType of ['pointerdown', 'mousedown', 'focusin']) {
    environment.document.addEventListener(eventType, remember, true);
  }

  environment.state.listenersBound = true;
}

export function rememberStartMarkerFromEvent(
  event: Event,
  environment: StartMarkerEnvironment
): void {
  if (!environment.isElement(event.target)) {
    return;
  }

  const targetElement = resolveStartMarkerTargetElement(
    environment.document,
    event.target
  );
  if (!targetElement) {
    if (isEditorSurfaceElement(environment.document, event.target)) {
      environment.state.marker = undefined;
    }
    return;
  }

  environment.state.marker = createStartMarker(
    environment.document,
    targetElement,
    environment.now()
  );
}

export function readFreshStartMarker(
  environment: StartMarkerEnvironment = createBrowserEnvironment()
): StartMarker | null {
  const marker = environment.state.marker;
  if (marker) {
    if (
      !marker.setAt ||
      environment.now() - marker.setAt <= START_MARKER_MAX_AGE_MS
    ) {
      return marker;
    }

    environment.state.marker = undefined;
  }

  const activeElement = environment.document.activeElement;
  if (!environment.isElement(activeElement)) {
    return null;
  }

  const targetElement = resolveStartMarkerTargetElement(
    environment.document,
    activeElement
  );
  if (!targetElement) {
    return null;
  }

  const activeMarker = createStartMarker(
    environment.document,
    targetElement,
    environment.now()
  );
  environment.state.marker = activeMarker;
  return activeMarker;
}

export function clearStartMarker(
  environment: StartMarkerEnvironment = createBrowserEnvironment()
): void {
  environment.state.marker = undefined;
}

export function createStartMarker(
  documentRoot: Document,
  targetElement: Element,
  setAt: number
): StartMarker {
  return {
    targetElement,
    domId: readLikelyTargetDomId(documentRoot, targetElement),
    setAt
  };
}

export function resolveStartMarkerTargetElement(
  documentRoot: Document,
  element: Element
): Element | null {
  const gientransTarget = element.closest<HTMLElement>(GIENTRANS_START_TARGET_SELECTOR);
  if (gientransTarget) {
    return gientransTarget;
  }

  const gientransTargetCell = element.closest<HTMLElement>(
    GIENTRANS_START_TARGET_CELL_SELECTOR
  );
  const gientransCellTarget = gientransTargetCell?.querySelector<HTMLElement>(
    GIENTRANS_START_TARGET_SELECTOR
  );
  if (gientransCellTarget) {
    return gientransCellTarget;
  }

  const phraseTarget = element.closest<HTMLElement>(PHRASE_START_TARGET_SELECTOR);
  if (phraseTarget) {
    return phraseTarget;
  }

  return findMemoqStartTargetCell(documentRoot, element);
}

export function readLikelyTargetDomId(
  documentRoot: Document,
  targetElement: Element
): string | null {
  const memoqRowId = readMemoqStartMarkerDomId(documentRoot, targetElement);
  if (memoqRowId) {
    return memoqRowId;
  }

  const gientransTarget = targetElement.matches(GIENTRANS_START_TARGET_SELECTOR)
    ? targetElement
    : targetElement.querySelector(GIENTRANS_START_TARGET_SELECTOR);
  const gientransSegmentId = gientransTarget?.getAttribute('segid');
  if (gientransSegmentId) {
    return gientransSegmentId;
  }

  const phraseRow = targetElement.closest<HTMLElement>(PHRASE_ROW_SELECTOR);
  return (
    firstNonEmptyAttribute(phraseRow, ['id', 'data-position', 'data-row']) ??
    firstNonEmptyAttribute(targetElement, ['id', 'data-position', 'data-row'])
  );
}

export function isEditorSurfaceElement(
  documentRoot: Document,
  element: Element
): boolean {
  return Boolean(
    element.closest(EDITOR_SURFACE_SELECTOR) ||
      findMemoqStartTargetCell(documentRoot, element)
  );
}

function firstNonEmptyAttribute(
  element: Element | null | undefined,
  names: string[]
): string | null {
  if (!element) {
    return null;
  }

  for (const name of names) {
    const value = element.getAttribute(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function createBrowserEnvironment(): StartMarkerEnvironment {
  const state: StartMarkerState = {
    get marker() {
      return window.__phraseBulkFillStartMarker;
    },
    set marker(value) {
      window.__phraseBulkFillStartMarker = value;
    },
    get listenersBound() {
      return window.__phraseBulkFillStartMarkerBound;
    },
    set listenersBound(value) {
      window.__phraseBulkFillStartMarkerBound = value;
    }
  };

  return {
    document,
    state,
    now: () => Date.now(),
    isElement: (value): value is Element => value instanceof Element
  };
}
