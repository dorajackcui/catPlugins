import type { RuntimeSegment } from './types.ts';
import type { MemoqFillExecutionContext } from '../platforms/runtime.ts';
import type { FillOutcome } from '../shared/fill-outcome-types.ts';
import type { ReportRunProgressRequest } from '../shared/message-types.ts';
import type {
  SegmentScanCallback,
  SegmentScanOptions
} from './segment-scanner.ts';

export interface FillRunOptions {
  maxPasses?: number;
  maxSegments?: number;
  scanFromTop?: boolean;
  startFromMarker?: boolean;
}

export interface FillRunnerScanner {
  collect(
    onSegment?: SegmentScanCallback,
    options?: SegmentScanOptions
  ): Promise<RuntimeSegment[]>;
}

export interface FillRunnerRuntime {
  isMemoqActive(): boolean;
  prepareMemoqTrustedInput(): Promise<void>;
  getEditableValue(segment: RuntimeSegment): string;
  fillSegment(
    segment: RuntimeSegment,
    value: string,
    memoqContext?: MemoqFillExecutionContext
  ): Promise<FillOutcome>;
}

export type FillRunProgress = Omit<ReportRunProgressRequest['payload'], 'runId'>;

export interface FillSegmentProcessorPort {
  runtime: FillRunnerRuntime;
  reportProgress(runId: string, progress: FillRunProgress): Promise<void>;
  assertNotStopped(): void;
  waitWithStopChecks(delayMs: number): Promise<void>;
  delay(delayMs: number): Promise<void>;
  logInfo(label: string, payload: Record<string, unknown>): void;
  logWarn(label: string, payload: Record<string, unknown>): void;
}

export interface FillRunnerPort extends FillSegmentProcessorPort {
  scanner: FillRunnerScanner;
  logError(label: string, payload: Record<string, unknown>): void;
}
