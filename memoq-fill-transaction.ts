import type { RuntimeSegment } from './content-script-dom.ts';
import type { MemoqDomProfile } from './memoq-dom-profile.ts';
import { isMemoqCommittedTargetText } from './memoq-text.ts';
import type {
  FillOutcome,
  MemoqFillDiagnostic,
  MemoqFillFailureCode,
  MemoqFillFailureDiagnostic,
  MemoqFillSuccessDiagnostic,
  MemoqVisibleRowSnapshot
} from './types.ts';
import { normalizeText } from './utils.ts';

const MEMOQ_COMMIT_CONFIRM_ATTEMPTS = 14;
const MEMOQ_COMMIT_CONFIRM_DELAY_MS = 150;

export interface MemoqFillTransactionOptions {
  profile: MemoqDomProfile;
  readTargetText(target: HTMLElement): string;
  readSourceText(segment: RuntimeSegment): string;
  collectNearbyRows(rowNumber?: string): MemoqVisibleRowSnapshot[];
  writeTrustedText(target: HTMLElement, value: string): Promise<void>;
  runId?: string;
  sequence?: number;
  scanPass?: number;
  scrollTop?: number;
  scrollMode?: 'native' | 'synthetic';
}

export class MemoqFillTransaction {
  constructor(private readonly options: MemoqFillTransactionOptions) {}

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const rowNumber = segment.rowNumber ?? '';
    const target = this.options.profile.findCurrentTargetByRowNumber(
      globalThis.document as Document,
      rowNumber
    );

    if (!target) {
      const diagnostic = this.createDiagnostic({
        segment,
        value,
        failureCode: 'ROW_NOT_FOUND',
        sourceBefore: '',
        targetBefore: '',
        targetAfter: '',
        confirmationAttempts: 0,
        activationAttempted: false,
        activationOk: false
      }) as MemoqFillFailureDiagnostic;

      return {
        domId: segment.domId,
        filled: false,
        diagnostic
      };
    }

    const sourceBefore = this.options.readSourceText(segment);
    const targetBefore = this.options.readTargetText(target);

    if (normalizeText(sourceBefore) !== normalizeText(segment.sourceRaw)) {
      const diagnostic = this.createDiagnostic({
        segment,
        value,
        failureCode: 'SOURCE_MISMATCH',
        sourceBefore,
        targetBefore,
        targetAfter: targetBefore,
        confirmationAttempts: 0,
        activationAttempted: false,
        activationOk: false
      }) as MemoqFillFailureDiagnostic;

      return {
        domId: segment.domId,
        filled: false,
        diagnostic
      };
    }

    if (normalizeText(targetBefore) !== '') {
      const diagnostic = this.createDiagnostic({
        segment,
        value,
        failureCode: 'TARGET_NOT_EMPTY',
        sourceBefore,
        targetBefore,
        targetAfter: targetBefore,
        confirmationAttempts: 0,
        activationAttempted: false,
        activationOk: false
      }) as MemoqFillFailureDiagnostic;

      return {
        domId: segment.domId,
        filled: false,
        diagnostic
      };
    }

    try {
      await this.options.writeTrustedText(
        this.options.profile.getWriteTarget(target),
        value
      );
    } catch (error) {
      const targetAfter = this.options.readTargetText(target);
      const diagnostic = this.createDiagnostic({
        segment,
        value,
        failureCode: 'INPUT_FAILED',
        sourceBefore,
        targetBefore,
        targetAfter,
        confirmationAttempts: 0,
        activationAttempted: true,
        activationOk: false,
        activationError: describeError(error)
      }) as MemoqFillFailureDiagnostic;

      return {
        domId: segment.domId,
        filled: false,
        diagnostic
      };
    }

    const confirmation = await this.confirmTargetText(target, value);
    if (!confirmation.ok) {
      const diagnostic = this.createDiagnostic({
        segment,
        value,
        failureCode: 'CONFIRM_TIMEOUT',
        sourceBefore,
        targetBefore,
        targetAfter: confirmation.targetAfter,
        confirmationAttempts: confirmation.attempts,
        activationAttempted: true,
        activationOk: true
      }) as MemoqFillFailureDiagnostic;

      return {
        domId: segment.domId,
        filled: false,
        diagnostic
      };
    }

    const diagnostic = this.createDiagnostic({
      segment,
      value,
      sourceBefore,
      targetBefore,
      targetAfter: confirmation.targetAfter,
      confirmationAttempts: confirmation.attempts,
      activationAttempted: true,
      activationOk: true
    }) as MemoqFillSuccessDiagnostic;

    return {
      domId: segment.domId,
      filled: true,
      diagnostic
    };
  }

  private async confirmTargetText(
    target: HTMLElement,
    value: string
  ): Promise<{ ok: boolean; attempts: number; targetAfter: string }> {
    let targetAfter = '';

    for (let attempt = 1; attempt <= MEMOQ_COMMIT_CONFIRM_ATTEMPTS; attempt += 1) {
      targetAfter = this.options.readTargetText(target);
      if (isMemoqCommittedTargetText(targetAfter, value)) {
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
      targetAfter
    };
  }

  private createDiagnostic({
    segment,
    value,
    failureCode,
    sourceBefore,
    targetBefore,
    targetAfter,
    confirmationAttempts,
    activationAttempted,
    activationOk,
    activationError
  }: {
    segment: RuntimeSegment;
    value: string;
    failureCode?: MemoqFillFailureCode;
    sourceBefore: string;
    targetBefore: string;
    targetAfter: string;
    confirmationAttempts: number;
    activationAttempted: boolean;
    activationOk: boolean;
    activationError?: string;
  }): MemoqFillDiagnostic {
    const rowNumber = segment.rowNumber;

    return {
      runId: this.options.runId ?? '',
      sequence: this.options.sequence ?? 0,
      scanPass: this.options.scanPass ?? 0,
      scrollTop: this.options.scrollTop ?? 0,
      scrollMode: this.options.scrollMode ?? 'native',
      profileId: this.options.profile.id,
      domId: segment.domId,
      rowNumber,
      locatingMethod: rowNumber ? 'rowNumber' : 'none',
      segmentSource: segment.sourceRaw,
      sourceBefore,
      targetBefore,
      expectedTranslation: value,
      activation: {
        attempted: activationAttempted,
        ok: activationOk,
        activeElement: describeActiveElement(),
        error: activationError
      },
      inputMethod: 'chrome-debugger',
      targetAfter,
      confirmation: {
        ok: failureCode === undefined,
        attempts: confirmationAttempts
      },
      nearbyRows: this.options.collectNearbyRows(rowNumber),
      outcome: failureCode ? 'failure' : 'success',
      failureCode
    } as MemoqFillDiagnostic;
  }
}

function wait(ms: number): Promise<void> {
  const setTimer =
    typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);

  return new Promise((resolve) => {
    setTimer(resolve, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeActiveElement(): string {
  const activeElement = globalThis.document?.activeElement as HTMLElement | null | undefined;
  if (!activeElement) {
    return 'none';
  }

  const tagName = activeElement.tagName?.toLowerCase() ?? 'element';
  const id = activeElement.id ? `#${activeElement.id}` : '';
  const className = String(activeElement.className || '').trim().replace(/\s+/g, '.');
  const classSuffix = className ? `.${className}` : '';

  return `${tagName}${id}${classSuffix}`;
}
