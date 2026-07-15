import type { RuntimeSegment } from '../../content/types.ts';
import type {
  MemoqFillDiagnosticBase,
  MemoqFillFailureCode,
  MemoqFillFailureDiagnostic,
  MemoqFillSuccessDiagnostic,
  MemoqVisibleRowSnapshot
} from '../../shared/types.ts';
import type { MemoqDomProfileId } from './dom-profile-types.ts';

export interface MemoqFillDiagnosticBuilderOptions {
  profileId: MemoqDomProfileId;
  collectNearbyRows(rowNumber?: string): MemoqVisibleRowSnapshot[];
  runId?: string;
  sequence?: number;
  scanPass?: number;
  scrollTop?: number;
  scrollMode?: 'native' | 'synthetic';
}

export interface MemoqFillDiagnosticInput {
  segment: RuntimeSegment;
  value: string;
  sourceBefore: string;
  targetBefore: string;
  targetAfter: string;
  confirmationAttempts: number;
  activationAttempted: boolean;
  activationOk: boolean;
  activationError?: string;
}

export class MemoqFillDiagnosticBuilder {
  constructor(private readonly options: MemoqFillDiagnosticBuilderOptions) {}

  createSuccess(input: MemoqFillDiagnosticInput): MemoqFillSuccessDiagnostic {
    return {
      ...this.createBase(input, true),
      outcome: 'success'
    };
  }

  createFailure(
    input: MemoqFillDiagnosticInput & { failureCode: MemoqFillFailureCode }
  ): MemoqFillFailureDiagnostic {
    return {
      ...this.createBase(input, false),
      outcome: 'failure',
      failureCode: input.failureCode
    };
  }

  private createBase(
    input: MemoqFillDiagnosticInput,
    confirmationOk: boolean
  ): MemoqFillDiagnosticBase {
    const rowNumber = input.segment.rowNumber;

    return {
      runId: this.options.runId ?? '',
      sequence: this.options.sequence ?? 0,
      scanPass: this.options.scanPass ?? 0,
      scrollTop: this.options.scrollTop ?? 0,
      scrollMode: this.options.scrollMode ?? 'native',
      profileId: this.options.profileId,
      domId: input.segment.domId,
      rowNumber,
      locatingMethod: rowNumber ? 'rowNumber' : 'none',
      segmentSource: input.segment.sourceRaw,
      sourceBefore: input.sourceBefore,
      targetBefore: input.targetBefore,
      expectedTranslation: input.value,
      activation: {
        attempted: input.activationAttempted,
        ok: input.activationOk,
        activeElement: describeActiveElement(),
        error: input.activationError
      },
      inputMethod: 'chrome-debugger',
      targetAfter: input.targetAfter,
      confirmation: {
        ok: confirmationOk,
        attempts: input.confirmationAttempts
      },
      nearbyRows: this.options.collectNearbyRows(rowNumber)
    };
  }
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
