import type { RunKind, RunPhase, RunState, StatusKind } from './types.ts';

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
