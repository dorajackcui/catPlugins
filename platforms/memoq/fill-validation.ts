import type { RuntimeSegment } from '../../content/types.ts';
import type { MemoqFillFailureCode } from '../../shared/fill-outcome-types.ts';
import { normalizeText } from '../../shared/utils.ts';

export type MemoqFillValidationFailureCode = Extract<
  MemoqFillFailureCode,
  'ROW_NOT_FOUND' | 'SOURCE_MISMATCH' | 'TARGET_NOT_EMPTY'
>;

export interface MemoqFillValidationPort {
  readTargetText(target: HTMLElement): string;
  readSourceText(segment: RuntimeSegment): string | null;
}

export interface MemoqValidFillSnapshot {
  ok: true;
  sourceBefore: string;
  targetBefore: string;
}

export interface MemoqInvalidFillSnapshot {
  ok: false;
  failureCode: MemoqFillValidationFailureCode;
  sourceBefore: string;
  targetBefore: string;
}

export type MemoqFillValidationResult =
  | MemoqValidFillSnapshot
  | MemoqInvalidFillSnapshot;

export function validateMemoqFillTarget(
  segment: RuntimeSegment,
  target: HTMLElement,
  port: MemoqFillValidationPort
): MemoqFillValidationResult {
  const currentSource = port.readSourceText(segment);
  const targetBefore = port.readTargetText(target);

  if (currentSource === null) {
    return {
      ok: false,
      failureCode: 'ROW_NOT_FOUND',
      sourceBefore: '',
      targetBefore
    };
  }

  if (normalizeText(currentSource) !== normalizeText(segment.sourceRaw)) {
    return {
      ok: false,
      failureCode: 'SOURCE_MISMATCH',
      sourceBefore: currentSource,
      targetBefore
    };
  }

  if (normalizeText(targetBefore) !== '') {
    return {
      ok: false,
      failureCode: 'TARGET_NOT_EMPTY',
      sourceBefore: currentSource,
      targetBefore
    };
  }

  return {
    ok: true,
    sourceBefore: currentSource,
    targetBefore
  };
}
