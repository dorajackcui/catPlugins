import { ContentScriptDomHelpers } from '../content/dom.ts';
import type {
  EditableElement,
  RuntimeSegment,
  ScrollContext
} from '../content/types.ts';
import type { FillOutcome } from '../shared/fill-outcome-types.ts';
import { normalizeText } from '../shared/utils.ts';
import { requireEditorPlatform, type EditorPlatform } from '../shared/editor-platform.ts';
import { GientTransAdapter } from './gientrans/adapter.ts';
import {
  MemoqAdapter,
  type MemoqFillExecutionContext
} from './memoq/adapter.ts';
import { PhraseAdapter } from './phrase/adapter.ts';

export type { MemoqFillExecutionContext } from './memoq/adapter.ts';

export function shouldRejectNonEmptyTarget(
  platform: RuntimeSegment['platform'],
  currentValue: string
): boolean {
  return platform !== 'gientrans' && Boolean(normalizeText(currentValue));
}

export interface MemoqRuntimePort {
  isActive(): boolean;
  findScrollContext(): ScrollContext | null;
  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[];
  fillSegment(
    segment: RuntimeSegment,
    value: string,
    context?: MemoqFillExecutionContext
  ): Promise<FillOutcome>;
  prepareTrustedInput(): Promise<void>;
}

export interface GientTransRuntimePort {
  findScrollContext(): ScrollContext | null;
  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[];
  getEditableValue(targetElement: HTMLElement): string;
  fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome>;
}

export interface PhraseRuntimePort {
  findScrollContext(): ScrollContext | null;
  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[];
  getEditableValue(targetElement: EditableElement): string;
  fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome>;
}

export class PlatformRuntime {
  private platform: EditorPlatform | null = null;

  selectPlatform(platform: EditorPlatform): void {
    this.platform = requireEditorPlatform(platform);
  }

  constructor(
    private readonly memoq: MemoqRuntimePort,
    private readonly gientrans: GientTransRuntimePort,
    private readonly phrase: PhraseRuntimePort,
    private readonly createFallbackScrollContext: () => ScrollContext
  ) {}

  isMemoqActive(): boolean {
    return this.platform === 'memoq';
  }

  prepareMemoqTrustedInput(): Promise<void> {
    return this.memoq.prepareTrustedInput();
  }

  findScrollContext(): ScrollContext {
    const platform = requireEditorPlatform(this.platform);
    return this[platform].findScrollContext() ?? this.createFallbackScrollContext();
  }

  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const platform = requireEditorPlatform(this.platform);
    return this[platform].collectVisibleSegments(scrollContext);
  }

  getEditableValue(segment: RuntimeSegment): string {
    const isGientTrans = segment.platform === 'gientrans';
    if (isGientTrans) {
      return this.gientrans.getEditableValue(segment.targetElement as HTMLElement);
    }

    return this.phrase.getEditableValue(segment.targetElement);
  }

  async fillSegment(
    segment: RuntimeSegment,
    value: string,
    memoqContext?: MemoqFillExecutionContext
  ): Promise<FillOutcome> {
    if (segment.platform === 'memoq') {
      return this.memoq.fillSegment(segment, value, memoqContext);
    }

    const isGientTrans = segment.platform === 'gientrans';
    if (isGientTrans) {
      return this.gientrans.fillSegment(segment, value);
    }

    return this.phrase.fillSegment(segment, value);
  }
}

export function createPlatformRuntime(helpers: ContentScriptDomHelpers): PlatformRuntime {
  return new PlatformRuntime(
    new MemoqAdapter(helpers),
    new GientTransAdapter(helpers),
    new PhraseAdapter(helpers),
    () => helpers.toWindowScrollContext()
  );
}
