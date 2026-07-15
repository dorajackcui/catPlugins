import {
  describeRunState,
  isRunActive,
  normalizeRunState
} from '../domain/run-state.ts';
import type { RunState, StatusKind } from '../shared/state-types.ts';

const REFRESH_INTERVAL_MS = 1000;

export interface PopupRunMonitorView {
  setBusy(busy: boolean): void;
  setStopping(stopping: boolean): void;
  renderStatus(message: string, kind?: StatusKind): void;
}

export interface PopupRunMonitorPort {
  view: PopupRunMonitorView;
  refreshState(): Promise<void>;
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(timerId: number): void;
}

/** Owns popup run-state rendering, refresh polling, and Stop gating. */
export class PopupRunMonitor {
  private busy = false;
  private stopping = false;
  private refreshTimerId: number | null = null;

  constructor(private readonly port: PopupRunMonitorPort) {}

  renderRunState(runState?: RunState | null): void {
    const normalizedRunState = normalizeRunState(runState);
    this.setBusy(isRunActive(normalizedRunState));
    this.setStopping(normalizedRunState.phase === 'stopping');
    this.port.view.renderStatus(
      describeRunState(normalizedRunState),
      normalizedRunState.statusKind
    );

    if (isRunActive(normalizedRunState)) {
      this.startRefreshLoop();
      return;
    }

    this.stopRefreshLoop();
  }

  beginRun(message: string): void {
    this.setBusy(true);
    this.setStopping(false);
    this.port.view.renderStatus(message);
    this.startRefreshLoop();
  }

  finishRun(): void {
    this.setStopping(false);
    this.setBusy(false);
  }

  setBusy(nextBusy: boolean): void {
    this.busy = nextBusy;
    this.port.view.setBusy(nextBusy);
  }

  tryBeginStop(): boolean {
    if (!this.busy || this.stopping) {
      return false;
    }

    this.setStopping(true);
    this.port.view.renderStatus('Stopping current run...');
    return true;
  }

  failStop(error: unknown): void {
    this.setStopping(false);
    this.port.view.renderStatus(
      error instanceof Error ? error.message : 'Stop failed.',
      'error'
    );
  }

  private setStopping(nextStopping: boolean): void {
    this.stopping = nextStopping;
    this.port.view.setStopping(nextStopping);
  }

  private startRefreshLoop(): void {
    if (this.refreshTimerId !== null) {
      return;
    }

    this.refreshTimerId = this.port.setInterval(() => {
      void this.port.refreshState().catch((error) => {
        this.stopRefreshLoop();
        this.port.view.renderStatus(
          error instanceof Error
            ? error.message
            : 'Failed to refresh state.',
          'error'
        );
      });
    }, REFRESH_INTERVAL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimerId === null) {
      return;
    }

    this.port.clearInterval(this.refreshTimerId);
    this.refreshTimerId = null;
  }
}
