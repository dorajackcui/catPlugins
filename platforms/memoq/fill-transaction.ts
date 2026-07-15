import type { RuntimeSegment } from '../../content/types.ts';
import type {
  FillOutcome,
  MemoqFillFailureCode,
  MemoqVisibleRowSnapshot
} from '../../shared/types.ts';
import type { MemoqDomProfile } from './dom-profile.ts';
import { confirmMemoqTargetText } from './fill-confirmation.ts';
import {
  MemoqFillDiagnosticBuilder,
  type MemoqFillDiagnosticInput
} from './fill-diagnostic-builder.ts';
import {
  validateMemoqFillTarget,
  type MemoqInvalidFillSnapshot
} from './fill-validation.ts';

export interface MemoqFillTransactionOptions {
  profile: MemoqDomProfile;
  readTargetText(target: HTMLElement): string;
  readSourceText(segment: RuntimeSegment): string | null;
  resolveCurrentTarget?(rowNumber: string): HTMLElement | null;
  collectNearbyRows(rowNumber?: string): MemoqVisibleRowSnapshot[];
  writeTrustedText(target: HTMLElement, value: string): Promise<void>;
  runId?: string;
  sequence?: number;
  scanPass?: number;
  scrollTop?: number;
  scrollMode?: 'native' | 'synthetic';
}

export class MemoqFillTransaction {
  private readonly diagnostics: MemoqFillDiagnosticBuilder;

  constructor(private readonly options: MemoqFillTransactionOptions) {
    this.diagnostics = new MemoqFillDiagnosticBuilder({
      profileId: options.profile.id,
      collectNearbyRows: (rowNumber) => options.collectNearbyRows(rowNumber),
      runId: options.runId,
      sequence: options.sequence,
      scanPass: options.scanPass,
      scrollTop: options.scrollTop,
      scrollMode: options.scrollMode
    });
  }

  async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    const rowNumber = segment.rowNumber ?? '';
    const currentTarget = this.resolveCurrentTarget(segment);
    let target = currentTarget ??
      (segment.rowNumber ? null : segment.targetElement as HTMLElement | null);

    if (!target) {
      return this.createFailureOutcome({
        segment,
        value,
        failureCode: 'ROW_NOT_FOUND',
        sourceBefore: '',
        targetBefore: '',
        targetAfter: '',
        confirmationAttempts: 0,
        activationAttempted: false,
        activationOk: false
      });
    }

    const initialValidation = validateMemoqFillTarget(segment, target, this.options);
    if (!initialValidation.ok) {
      return this.createValidationFailureOutcome(segment, value, initialValidation);
    }

    let { sourceBefore, targetBefore } = initialValidation;
    const writeTarget = segment.rowNumber ? this.resolveCurrentTarget(segment) : target;
    if (!writeTarget) {
      return this.createFailureOutcome({
        segment,
        value,
        failureCode: 'ROW_NOT_FOUND',
        sourceBefore,
        targetBefore,
        targetAfter: targetBefore,
        confirmationAttempts: 0,
        activationAttempted: false,
        activationOk: false
      });
    }

    if (writeTarget !== target) {
      target = writeTarget;
      const currentValidation = validateMemoqFillTarget(segment, target, this.options);
      if (!currentValidation.ok) {
        return this.createValidationFailureOutcome(segment, value, currentValidation);
      }

      sourceBefore = currentValidation.sourceBefore;
      targetBefore = currentValidation.targetBefore;
    }

    try {
      await this.options.writeTrustedText(
        this.options.profile.getWriteTarget(writeTarget),
        value
      );
    } catch (error) {
      const targetAfter = this.options.readTargetText(target);
      return this.createFailureOutcome({
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
      });
    }

    const confirmation = await confirmMemoqTargetText({
      target,
      rowNumber,
      value,
      readTargetText: (currentTarget) => this.options.readTargetText(currentTarget),
      resolveCurrentTargetByRowNumber: (currentRowNumber) =>
        this.resolveCurrentTargetByRowNumber(currentRowNumber)
    });
    if (!confirmation.ok) {
      return this.createFailureOutcome({
        segment,
        value,
        failureCode: confirmation.failureCode ?? 'CONFIRM_TIMEOUT',
        sourceBefore,
        targetBefore,
        targetAfter: confirmation.targetAfter,
        confirmationAttempts: confirmation.attempts,
        activationAttempted: true,
        activationOk: true
      });
    }

    return {
      domId: segment.domId,
      filled: true,
      diagnostic: this.diagnostics.createSuccess({
        segment,
        value,
        sourceBefore,
        targetBefore,
        targetAfter: confirmation.targetAfter,
        confirmationAttempts: confirmation.attempts,
        activationAttempted: true,
        activationOk: true
      })
    };
  }

  private resolveCurrentTarget(segment: RuntimeSegment): HTMLElement | null {
    if (!segment.rowNumber) {
      return null;
    }

    return this.resolveCurrentTargetByRowNumber(segment.rowNumber);
  }

  private resolveCurrentTargetByRowNumber(rowNumber: string): HTMLElement | null {
    if (this.options.resolveCurrentTarget) {
      return this.options.resolveCurrentTarget(rowNumber);
    }

    return this.options.profile.findCurrentTargetByRowNumber(
      globalThis.document as Document,
      rowNumber
    );
  }

  private createValidationFailureOutcome(
    segment: RuntimeSegment,
    value: string,
    validation: MemoqInvalidFillSnapshot
  ): FillOutcome {
    return this.createFailureOutcome({
      segment,
      value,
      failureCode: validation.failureCode,
      sourceBefore: validation.sourceBefore,
      targetBefore: validation.targetBefore,
      targetAfter: validation.targetBefore,
      confirmationAttempts: 0,
      activationAttempted: false,
      activationOk: false
    });
  }

  private createFailureOutcome(
    input: MemoqFillDiagnosticInput & { failureCode: MemoqFillFailureCode }
  ): FillOutcome {
    return {
      domId: input.segment.domId,
      filled: false,
      diagnostic: this.diagnostics.createFailure(input)
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
