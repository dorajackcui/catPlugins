import type { PageSegment } from '../shared/translation-types.ts';

export type EditableElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface ScrollContext {
  initialTop: number;
  mode?: 'native' | 'synthetic';
  /** The editor exposes its own scrollbar endpoints and acknowledges each move. */
  hasVerifiedScrollBounds?: boolean;
  /** Render the current export page and return every document row number it contains. */
  readExportRowNumbers?(checkStop: () => void): Promise<string[]>;
  getTop(): number;
  getHeight(): number;
  scrollBy(delta: number): void | Promise<void>;
  scrollToTop(checkStop?: () => void): void | Promise<void>;
  isAtBottom(): boolean;
  restore(): void | Promise<void>;
}

export interface RuntimeSegment extends PageSegment {
  targetElement: EditableElement;
  platform: NonNullable<PageSegment['platform']>;
  phraseUsesTagMarkup?: boolean;
  scanElement?: Element;
  scanFingerprint?: string;
}

export function toPageSegment(segment: RuntimeSegment): PageSegment {
  const { targetElement, scanElement, scanFingerprint, phraseUsesTagMarkup, ...pageSegment } = segment;
  return pageSegment;
}
