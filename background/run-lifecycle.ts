import {
  createFinishedRunState,
  createRunningRunState,
  DEFAULT_RUN_STATE,
  normalizeRunState,
  type CreateFinishedRunStateOptions
} from '../domain/run-state.ts';
import { describeRunFailure } from '../domain/run-stop.ts';
import type { FillOptions } from '../shared/translation-types.ts';
import type {
  RunKind,
  RunState,
  RuntimeState
} from '../shared/state-types.ts';
import type { RuntimeStateUpdate } from './storage.ts';

export interface BackgroundRunLifecyclePort {
  readRuntimeState(): Promise<RuntimeState>;
  writeRuntimeState(update: RuntimeStateUpdate): Promise<void>;
  now(): Date;
}

export interface StartBackgroundRunOptions {
  fillOptions?: FillOptions;
  plannedFillCount?: number | null;
}

export type FinishBackgroundRunFailureOptions = Pick<
  CreateFinishedRunStateOptions,
  'plannedFillCount'
>;

/** Owns persisted state transitions shared by all background run kinds. */
export class BackgroundRunLifecycle {
  constructor(private readonly port: BackgroundRunLifecyclePort) {}

  async start(
    kind: RunKind,
    target: { id: number; frameId?: number },
    options: StartBackgroundRunOptions = {}
  ): Promise<RunState> {
    const runState = createRunningRunState(kind, target, {
      plannedFillCount: options.plannedFillCount
    });
    const update: RuntimeStateUpdate = { runState };
    if (options.fillOptions !== undefined) {
      update.fillOptions = options.fillOptions;
    }
    await this.port.writeRuntimeState(update);
    return runState;
  }

  async finish(
    runId: string,
    options: CreateFinishedRunStateOptions
  ): Promise<void> {
    const latestState = await this.port.readRuntimeState();
    const currentRunState =
      latestState.runState.runId === runId
        ? latestState.runState
        : DEFAULT_RUN_STATE;

    await this.port.writeRuntimeState({
      runState: createFinishedRunState(currentRunState, options)
    });
  }

  async finishFailure(
    runId: string,
    error: unknown,
    fallback: string,
    options: FinishBackgroundRunFailureOptions = {}
  ): Promise<void> {
    await this.finish(runId, {
      ...options,
      ...describeRunFailure(error, fallback)
    });
  }

  async markStopping(runState: RunState): Promise<void> {
    await this.port.writeRuntimeState({
      runState: normalizeRunState({
        ...runState,
        phase: 'stopping',
        statusKind: 'default',
        lastUpdatedAt: this.port.now().toISOString()
      })
    });
  }
}
