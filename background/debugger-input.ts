import type { DebuggerInputOperation } from '../shared/message-types.ts';
import {
  DebuggerSession,
  type ChromeDebuggerInputApi,
  type DebuggerSessionOptions,
  type DebuggerTarget
} from './debugger-session.ts';

export type { ChromeDebuggerInputApi } from './debugger-session.ts';
export type DebuggerInputControllerOptions = DebuggerSessionOptions;

interface DebuggerKeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
}

const CONTROL_MODIFIER = 2;
const CONTROL_KEY: DebuggerKeyDescriptor = {
  key: 'Control',
  code: 'ControlLeft',
  windowsVirtualKeyCode: 17,
  nativeVirtualKeyCode: 17
};
const HOME_KEY: DebuggerKeyDescriptor = {
  key: 'Home',
  code: 'Home',
  windowsVirtualKeyCode: 36,
  nativeVirtualKeyCode: 36
};
const ARROW_RIGHT_KEY: DebuggerKeyDescriptor = {
  key: 'ArrowRight',
  code: 'ArrowRight',
  windowsVirtualKeyCode: 39,
  nativeVirtualKeyCode: 39
};
const DELETE_KEY: DebuggerKeyDescriptor = {
  key: 'Delete',
  code: 'Delete',
  windowsVirtualKeyCode: 46,
  nativeVirtualKeyCode: 46
};
const F9_KEY: DebuggerKeyDescriptor = {
  key: 'F9',
  code: 'F9',
  windowsVirtualKeyCode: 120,
  nativeVirtualKeyCode: 120
};
const Z_KEY: DebuggerKeyDescriptor = {
  key: 'z',
  code: 'KeyZ',
  windowsVirtualKeyCode: 90,
  nativeVirtualKeyCode: 90
};

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

    if (operation.type === 'documentHome') {
      await this.dispatchControlKey(target, HOME_KEY);
      return;
    }

    if (operation.type === 'moveRight') {
      if (
        !Number.isSafeInteger(operation.count) ||
        operation.count < 1 ||
        operation.count > 10000
      ) {
        throw new Error('Invalid trusted sequence cursor movement.');
      }

      for (let index = 0; index < operation.count; index += 1) {
        await this.dispatchKey(target, ARROW_RIGHT_KEY);
      }
      return;
    }

    if (operation.type === 'deleteForward') {
      await this.dispatchKey(target, DELETE_KEY);
      return;
    }

    if (operation.type === 'undo') {
      await this.dispatchControlKey(target, Z_KEY);
      return;
    }

    if (operation.type === 'key') {
      await this.dispatchKey(target, F9_KEY);
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

    if (operation.type === 'text' && operation.text) {
      await this.session.sendCommand(target, 'Input.insertText', {
        text: operation.text
      });
    }
  }

  private async dispatchKey(
    target: DebuggerTarget,
    key: DebuggerKeyDescriptor,
    modifiers = 0
  ): Promise<void> {
    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers,
      ...key
    });
    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      ...key
    });
  }

  private async dispatchControlKey(
    target: DebuggerTarget,
    key: DebuggerKeyDescriptor
  ): Promise<void> {
    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: CONTROL_MODIFIER,
      ...CONTROL_KEY
    });
    await this.dispatchKey(target, key, CONTROL_MODIFIER);
    await this.session.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 0,
      ...CONTROL_KEY
    });
  }
}
