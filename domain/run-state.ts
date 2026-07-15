import { normalizePlannedFillCount } from './fill-throttle.ts';
import type {
  ReportRunProgressRequest,
  RunKind,
  RunPhase,
  RunState,
  StatusKind
} from '../shared/types.ts';

export const DEFAULT_RUN_STATE: RunState = {
  runId: null,
  kind: null,
  phase: 'idle',
  statusKind: 'default',
  startedAt: null,
  lastUpdatedAt: null,
  tabId: null,
  frameId: null,
  plannedFillCount: null,
  scannedCount: 0,
  filledCount: 0,
  message: 'Ready.'
};

export interface CreateRunningRunStateOptions {
  plannedFillCount?: number | null;
  runId?: string;
  startedAt?: string;
}

export interface CreateFinishedRunStateOptions {
  message: string;
  statusKind?: StatusKind;
  scannedCount?: number;
  filledCount?: number;
  plannedFillCount?: number | null;
  finishedAt?: string;
}

function createRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRunningRunState(
  kind: RunKind,
  target: { id: number; frameId?: number },
  options: CreateRunningRunStateOptions = {}
): RunState {
  const startedAt = options.startedAt ?? new Date().toISOString();

  return normalizeRunState({
    runId: options.runId ?? createRunId(),
    kind,
    phase: 'running',
    statusKind: 'default',
    startedAt,
    lastUpdatedAt: startedAt,
    tabId: target.id,
    frameId: target.frameId ?? null,
    plannedFillCount: options.plannedFillCount ?? null,
    scannedCount: 0,
    filledCount: 0,
    message: ''
  });
}

export function createFinishedRunState(
  currentRunState: RunState,
  options: CreateFinishedRunStateOptions
): RunState {
  return normalizeRunState({
    ...DEFAULT_RUN_STATE,
    startedAt: currentRunState.startedAt,
    lastUpdatedAt: options.finishedAt ?? new Date().toISOString(),
    scannedCount: options.scannedCount ?? currentRunState.scannedCount,
    filledCount: options.filledCount ?? currentRunState.filledCount,
    plannedFillCount:
      options.plannedFillCount === undefined
        ? currentRunState.plannedFillCount
        : options.plannedFillCount,
    message: options.message,
    statusKind: options.statusKind ?? 'default'
  });
}

export function mergeRunProgress(
  currentRunState: RunState,
  payload: ReportRunProgressRequest['payload'],
  updatedAt = new Date().toISOString()
): RunState {
  return normalizeRunState({
    ...currentRunState,
    phase:
      currentRunState.phase === 'stopping'
        ? 'stopping'
        : payload.phase ?? currentRunState.phase,
    lastUpdatedAt: updatedAt,
    scannedCount:
      typeof payload.scannedCount === 'number'
        ? Math.max(currentRunState.scannedCount, Math.floor(payload.scannedCount))
        : currentRunState.scannedCount,
    filledCount:
      typeof payload.filledCount === 'number'
        ? Math.max(currentRunState.filledCount, Math.floor(payload.filledCount))
        : currentRunState.filledCount,
    plannedFillCount:
      payload.plannedFillCount === undefined
        ? currentRunState.plannedFillCount
        : normalizePlannedFillCount(payload.plannedFillCount),
    message:
      typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : currentRunState.message
  });
}

function normalizeCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizeOptionalCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

function normalizePhase(value: RunPhase | null | undefined): RunPhase {
  return value === 'running' || value === 'stopping' ? value : 'idle';
}

function normalizeKind(value: RunKind | null | undefined): RunKind | null {
  return value === 'preview' || value === 'fill' || value === 'export' ? value : null;
}

function normalizeStatusKind(value: StatusKind | null | undefined): StatusKind {
  return value === 'error' ? 'error' : 'default';
}

export function normalizeRunState(runState?: Partial<RunState> | null): RunState {
  const phase = normalizePhase(runState?.phase);
  const kind = normalizeKind(runState?.kind);

  return {
    runId:
      typeof runState?.runId === 'string' && runState.runId.trim()
        ? runState.runId
        : null,
    kind,
    phase,
    statusKind: normalizeStatusKind(runState?.statusKind),
    startedAt:
      typeof runState?.startedAt === 'string' && runState.startedAt.trim()
        ? runState.startedAt
        : null,
    lastUpdatedAt:
      typeof runState?.lastUpdatedAt === 'string' && runState.lastUpdatedAt.trim()
        ? runState.lastUpdatedAt
        : null,
    tabId: normalizeOptionalCount(runState?.tabId),
    frameId: normalizeOptionalCount(runState?.frameId),
    plannedFillCount: normalizeOptionalCount(runState?.plannedFillCount),
    scannedCount: normalizeCount(runState?.scannedCount),
    filledCount: normalizeCount(runState?.filledCount),
    message:
      typeof runState?.message === 'string' && runState.message.trim()
        ? runState.message
        : phase === 'idle'
          ? DEFAULT_RUN_STATE.message
          : ''
  };
}

export function isRunActive(runState?: RunState | null): boolean {
  const normalizedRunState = normalizeRunState(runState);
  return normalizedRunState.phase === 'running' || normalizedRunState.phase === 'stopping';
}

export function describeRunState(runState?: RunState | null): string {
  const normalizedRunState = normalizeRunState(runState);

  if (normalizedRunState.phase === 'stopping') {
    if (normalizedRunState.kind === 'preview') {
      return 'Stopping preview...';
    }

    if (normalizedRunState.kind === 'fill') {
      return 'Stopping fill...';
    }

    if (normalizedRunState.kind === 'export') {
      return 'Stopping export...';
    }

    return 'Stopping current task...';
  }

  if (normalizedRunState.phase === 'running') {
    if (normalizedRunState.kind === 'preview') {
      return `Preview running. Scanned ${normalizedRunState.scannedCount} segment(s)...`;
    }

    if (normalizedRunState.kind === 'fill') {
      const fillProgress =
        normalizedRunState.plannedFillCount !== null
          ? `Filled ${normalizedRunState.filledCount} / ${normalizedRunState.plannedFillCount} segment(s)`
          : `Filled ${normalizedRunState.filledCount} segment(s)`;
      return `${fillProgress}; scanned ${normalizedRunState.scannedCount}.`;
    }

    if (normalizedRunState.kind === 'export') {
      return `Export running. Scanned ${normalizedRunState.scannedCount} segment(s)...`;
    }

    return 'Task running...';
  }

  return normalizedRunState.message || DEFAULT_RUN_STATE.message;
}
