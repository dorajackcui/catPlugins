import type { DebuggerInputOperation } from '../shared/message-types.ts';
import {
  DebuggerSession,
  type ChromeDebuggerInputApi,
  type DebuggerSessionOptions,
  type DebuggerTarget
} from './debugger-session.ts';

export type { ChromeDebuggerInputApi } from './debugger-session.ts';
export type DebuggerInputControllerOptions = DebuggerSessionOptions;

/** Validates and dispatches trusted editor input through a debugger session. */
export class DebuggerInputController {
  private readonly session: DebuggerSession;

  constructor(
    api: ChromeDebuggerInputApi,
    options: DebuggerInputControllerOptions = {}
  ) {
    this.session = new DebuggerSession(api, options);
  }

  prepare(tabId: number): Promise<void> {
    return this.session.prepare(tabId);
  }

  keepAlive(tabId: number | undefined): void {
    this.session.keepAlive(tabId);
  }

  async writeText(
    tabId: number,
    x: number,
    y: number,
    text: string
  ): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
      throw new Error('Invalid trusted write payload.');
    }

    await this.prepare(tabId);
    const target = { tabId };
    await this.dispatchClick(target, x, y);
    await this.session.sendCommand(target, 'Input.insertText', { text });
    this.session.keepAlive(tabId);
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
      this.session.keepAlive(tabId);
    }
  }

  private async dispatchClick(
    target: DebuggerTarget,
    x: number,
    y: number
  ): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.session.sendCommand(target, 'Input.dispatchMouseEvent', {
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
      await this.session.sendCommand(target, 'Input.insertText', {
        text: operation.text
      });
    }
  }
}
