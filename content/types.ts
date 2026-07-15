export type EditableElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface ScrollContext {
  initialTop: number;
  mode?: 'native' | 'synthetic';
  getTop(): number;
  getHeight(): number;
  scrollBy(delta: number): void;
  scrollToTop(): void;
  isAtBottom(): boolean;
  restore(): void;
}

export interface RuntimeSegment {
  domId: string;
  rowNumber?: string;
  sourceRaw: string;
  sourceNormalized: string;
  occurrenceIndex: number;
  targetRaw: string;
  isEmptyTarget: boolean;
  placeholderTokens: string[];
  targetElement: EditableElement;
  platform: 'memoq' | 'gientrans' | 'phrase' | 'generic';
  phraseUsesTagMarkup?: boolean;
  scanElement?: Element;
  scanFingerprint?: string;
}
