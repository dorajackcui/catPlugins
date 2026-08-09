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
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    api: ChromeDebuggerInputApi,
    options: DebuggerInputControllerOptions = {}
  ) {
    this.session = new DebuggerSession(api, options);
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
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

    if (operation.type === 'key') {
      await this.dispatchF9(target);
      return;
    }

    if (operation.type === 'wait') {
      if (
        !Number.isFinite(operation.milliseconds) ||
        operation.milliseconds < 0 ||
        operation.milliseconds > 1000
      ) {
        throw new Error('Invalid trusted sequence wait duration.');
      }

      await this.sleep(operation.milliseconds);
      return;
    }

    if (operation.text) {
      await this.session.sendCommand(target, 'Input.insertText', {
        text: operation.text
      });
    }
  }

  private async dispatchF9(target: DebuggerTarget): Promise<void> {
    const keyParams = {
      key: 'F9',
      code: 'F9',
      windowsVirtualKeyCode: 120,
      nativeVirtualKeyCode: 120
    };

    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      ...keyParams
    });
    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...keyParams
    });
  }
}
