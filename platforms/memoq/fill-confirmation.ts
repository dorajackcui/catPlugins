import type { MemoqFillFailureCode } from '../../shared/types.ts';
import { isMemoqCommittedTargetText } from './text.ts';

const MEMOQ_COMMIT_CONFIRM_ATTEMPTS = 14;
const MEMOQ_COMMIT_CONFIRM_DELAY_MS = 150;

export interface MemoqFillConfirmationOptions {
  target: HTMLElement;
  rowNumber: string;
  value: string;
  readTargetText(target: HTMLElement): string;
  resolveCurrentTargetByRowNumber(rowNumber: string): HTMLElement | null;
}

export interface MemoqFillConfirmationResult {
  ok: boolean;
  attempts: number;
  targetAfter: string;
  failureCode?: Extract<MemoqFillFailureCode, 'ROW_NOT_FOUND'>;
}

export type MemoqFillConfirmationWait = (delayMs: number) => Promise<void>;

export async function confirmMemoqTargetText(
  options: MemoqFillConfirmationOptions,
  wait: MemoqFillConfirmationWait = waitForMemoqCommitCheck
): Promise<MemoqFillConfirmationResult> {
  let targetAfter = '';
  let resolvedAtLeastOnce = false;

  for (let attempt = 1; attempt <= MEMOQ_COMMIT_CONFIRM_ATTEMPTS; attempt += 1) {
    const currentTarget = options.rowNumber
      ? options.resolveCurrentTargetByRowNumber(options.rowNumber)
      : options.target;
    if (!currentTarget) {
      if (attempt < MEMOQ_COMMIT_CONFIRM_ATTEMPTS) {
        await wait(MEMOQ_COMMIT_CONFIRM_DELAY_MS);
      }
      continue;
    }

    resolvedAtLeastOnce = true;
    targetAfter = options.readTargetText(currentTarget);
    if (isMemoqCommittedTargetText(targetAfter, options.value)) {
      return {
        ok: true,
        attempts: attempt,
        targetAfter
      };
    }

    if (attempt < MEMOQ_COMMIT_CONFIRM_ATTEMPTS) {
      await wait(MEMOQ_COMMIT_CONFIRM_DELAY_MS);
    }
  }

  return {
    ok: false,
    attempts: MEMOQ_COMMIT_CONFIRM_ATTEMPTS,
    targetAfter,
    failureCode: resolvedAtLeastOnce ? undefined : 'ROW_NOT_FOUND'
  };
}

function waitForMemoqCommitCheck(ms: number): Promise<void> {
  const setTimer =
    typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);

  return new Promise((resolve) => {
    setTimer(resolve, ms);
  });
}
