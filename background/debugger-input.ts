import type { DebuggerInputOperation } from '../shared/types.ts';

const DEFAULT_PROTOCOL_VERSION = '1.3';
const DEFAULT_IDLE_DETACH_MS = 30000;
const DEFAULT_FRESH_ATTACH_SETTLE_MS = 600;

type DebuggerTarget = { tabId: number };
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ChromeDebuggerInputApi {
  runtime: {
    readonly lastError?: { message: string } | null;
  };
  debugger: {
    onDetach: {
      addListener(listener: (source: { tabId?: number }) => void): void;
    };
    attach(
      target: DebuggerTarget,
      requiredVersion: string,
      callback: () => void
    ): void;
    detach(target: DebuggerTarget, callback: () => void): void;
    sendCommand(
      target: DebuggerTarget,
      method: string,
      commandParams: Record<string, unknown>,
      callback: () => void
    ): void;
  };
}

export interface DebuggerInputControllerOptions {
  protocolVersion?: string;
  idleDetachMs?: number;
  freshAttachSettleMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimeout?: (timer: TimerHandle) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

interface DebuggerAttachment {
  idleTimer: TimerHandle | null;
}

/**
 * Keeps one Chrome Debugger attachment alive per tab while trusted editor
 * input is active. Reusing the attachment avoids infobar-driven relayouts
 * between coordinate measurement and input dispatch.
 */
export class DebuggerInputController {
  private readonly attachments = new Map<number, DebuggerAttachment>();
  // Attach and detach must not overlap for the same tab. Chrome rejects an
  // attach while an earlier idle detach is still in flight.
  private readonly transitions = new Map<number, Promise<void>>();
  private readonly protocolVersion: string;
  private readonly idleDetachMs: number;
  private readonly freshAttachSettleMs: number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimeout: (timer: TimerHandle) => void;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly api: ChromeDebuggerInputApi,
    options: DebuggerInputControllerOptions = {}
  ) {
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.idleDetachMs = options.idleDetachMs ?? DEFAULT_IDLE_DETACH_MS;
    this.freshAttachSettleMs =
      options.freshAttachSettleMs ?? DEFAULT_FRESH_ATTACH_SETTLE_MS;
    this.scheduleTimeout =
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = options.cancelTimeout ?? ((timer) => clearTimeout(timer));
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

    this.api.debugger.onDetach.addListener((source) => {
      this.handleDetached(source);
    });
  }

  async prepare(tabId: number): Promise<void> {
    await this.enqueueTransition(tabId, async () => {
      if (this.attachments.has(tabId)) {
        this.scheduleIdleDetach(tabId);
        return;
      }

      await new Promise<void>((resolve, reject) => {
        this.api.debugger.attach({ tabId }, this.protocolVersion, () => {
          const error = this.api.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }

          resolve();
        });
      });

      this.attachments.set(tabId, { idleTimer: null });
      this.scheduleIdleDetach(tabId);

      // A fresh debugger attachment shows an infobar and resizes the page.
      // Wait before callers measure editor coordinates.
      await this.sleep(this.freshAttachSettleMs);
    });
  }

  keepAlive(tabId: number | undefined): void {
    // Progress reports call this during long scans. It only extends an
    // existing attachment and never opens a debugger session by itself.
    if (typeof tabId === 'number' && this.attachments.has(tabId)) {
      this.scheduleIdleDetach(tabId);
    }
  }

  async writeText(tabId: number, x: number, y: number, text: string): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
      throw new Error('Invalid trusted write payload.');
    }

    await this.prepare(tabId);
    const target = { tabId };
    await this.dispatchClick(target, x, y);
    await this.sendCommand(target, 'Input.insertText', { text });
    this.scheduleIdleDetach(tabId);
  }

  async runSequence(
    tabId: number,
    x: number,
    y: number,
    operations: DebuggerInputOperation[]
  ): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !operations.length) {
      throw new Error('Invalid trusted sequence payload.');
    }

    await this.prepare(tabId);
    const target = { tabId };

    try {
      await this.dispatchClick(target, x, y);

      for (const operation of operations) {
        await this.dispatchOperation(target, operation);
      }
    } finally {
      this.scheduleIdleDetach(tabId);
    }
  }

  private handleDetached(source: { tabId?: number }): void {
    if (typeof source.tabId !== 'number') {
      return;
    }

    const attachment = this.attachments.get(source.tabId);
    if (attachment?.idleTimer !== null && attachment?.idleTimer !== undefined) {
      this.cancelTimeout(attachment.idleTimer);
    }
    this.attachments.delete(source.tabId);
  }

  private enqueueTransition(tabId: number, operation: () => Promise<void>): Promise<void> {
    const previous = this.transitions.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.transitions.set(
      tabId,
      next.catch(() => undefined)
    );
    return next;
  }

  private scheduleIdleDetach(tabId: number): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) {
      return;
    }

    if (attachment.idleTimer !== null) {
      this.cancelTimeout(attachment.idleTimer);
    }

    attachment.idleTimer = this.scheduleTimeout(() => {
      void this.enqueueTransition(tabId, async () => {
        if (!this.attachments.has(tabId)) {
          return;
        }

        this.attachments.delete(tabId);
        await new Promise<void>((resolve) => {
          this.api.debugger.detach({ tabId }, () => {
            void this.api.runtime.lastError;
            resolve();
          });
        });
      });
    }, this.idleDetachMs);
  }

  private async dispatchClick(target: DebuggerTarget, x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.sendCommand(target, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1
      });
    }
  }

  private async dispatchOperation(
    target: DebuggerTarget,
    operation: DebuggerInputOperation
  ): Promise<void> {
    if (operation.type === 'click') {
      if (!Number.isFinite(operation.x) || !Number.isFinite(operation.y)) {
        throw new Error('Invalid trusted sequence click coordinates.');
      }

      await this.dispatchClick(target, operation.x, operation.y);
      return;
    }

    if (operation.text) {
      await this.sendCommand(target, 'Input.insertText', { text: operation.text });
    }
  }

  private async sendCommand(
    target: DebuggerTarget,
    method: string,
    commandParams: Record<string, unknown>
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.api.debugger.sendCommand(target, method, commandParams, () => {
        const error = this.api.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }
}
