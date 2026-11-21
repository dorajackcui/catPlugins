import { writeTrustedInputSequenceToElement } from '../../content/trusted-text-writer.ts';
import { runtimeSendMessage } from '../../shared/chrome-api.ts';
import type { ApiResponse, MemoqDebuggerInsertFocusedTextRequest } from '../../shared/message-types.ts';
import { escapeMemoqPlainTargetText, serializeMemoqContentExact } from './text.ts';

interface WebTransInputOptions {
  target: HTMLElement;
  resolveTarget(): HTMLElement | null;
  getContentRoot(target: HTMLElement): HTMLElement;
  sourceMatches(): boolean;
  matchesTarget(cell: HTMLElement, expected: string): boolean;
  expected: string;
}

const POLL_MS = 40;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let loggedVerifiedInput = false;

/** webTrans shares one input across rows. Wait for the selected target to own it. */
export async function writeWebTransTarget(options: WebTransInputOptions): Promise<void> {
  const { expected, getContentRoot, matchesTarget, resolveTarget, sourceMatches, target } = options;
  const doc = target.ownerDocument;
  const resolveOptions = { requireResolvedElement: true, resolveElement: resolveTarget };
  const readyInput = (): HTMLInputElement | null => {
    const current = resolveTarget();
    const input = doc.activeElement;
    if (!current || !sourceMatches()) {
      throw new Error('The memoQ source row changed before text input.');
    }
    if (serializeMemoqContentExact(getContentRoot(current)) !== '') {
      throw new Error('The memoQ target changed before text input.');
    }
    if (input?.id !== 'editorHiddenInput' || !current.closest('.editor-cell-container.focused')) return null;
    const field = input as HTMLInputElement;
    return field.value === '' ? field : null;
  };

  // webTrans can absorb the first focus click while it commits the previous
  // row. Re-resolve and click once more only before sending any text.
  let input: HTMLInputElement | null = null;
  for (let click = 0; click < 2 && !input; click++) {
    await writeTrustedInputSequenceToElement(target, [{ type: 'wait', milliseconds: 150 }], resolveOptions);
    input = readyInput();
    for (let poll = 0; !input && poll < 10; poll++) {
      await pause(POLL_MS);
      input = readyInput();
    }
  }
  if (!input) throw new Error('The requested memoQ target did not receive the editing focus.');
  const text = escapeMemoqPlainTargetText(expected);
  let blocked = false;
  let before: InputEvent | undefined;
  let received = false;
  let receivedFullValue = false;
  const onInput = (event: Event) => {
    if (event.target !== input) return;
    received = true;
    receivedFullValue = input.value === text;
  };
  const guard = (event: InputEvent) => {
    if (event.data !== text) return;
    before = event;
    try {
      if (event.target === input && readyInput() === input) return;
    } catch { /* Cancel the pending input when the row is no longer writable. */ }
    blocked = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  doc.addEventListener('beforeinput', guard, true);
  doc.addEventListener('input', onInput, true);
  try {
    const result = await runtimeSendMessage<MemoqDebuggerInsertFocusedTextRequest, ApiResponse<null>>({
      type: 'MEMOQ_DEBUGGER_INSERT_FOCUSED_TEXT', payload: { text }
    });
    if (!result.ok) throw new Error(result.error);
    if (blocked) throw new Error('The active memoQ target changed at the moment of input.');
  } finally {
    doc.removeEventListener('beforeinput', guard, true);
    doc.removeEventListener('input', onInput, true);
  }
  const inputState = () => JSON.stringify({
    before: !!before, canceled: before?.defaultPrevented ?? false, received, receivedFullValue,
    buffered: input.value.length, pendingFullValue: input.value === text, focused: doc.activeElement === input,
    readOnly: input.readOnly, disabled: input.disabled, documentFocused: doc.hasFocus?.()
  });
  let stable = 0;
  let observed = '';
  for (let attempt = 0; attempt < 55; attempt++) {
    const current = resolveTarget();
    if (!current) throw new Error('The memoQ row disappeared while verifying the translation.');
    if (matchesTarget(current, expected)) {
      if (++stable === 4) {
        if (!loggedVerifiedInput) {
          console.info('[Phrase Bulk Fill] webTrans verified input', inputState());
          loggedVerifiedInput = true;
        }
        return;
      }
    } else {
      stable = 0;
      observed = serializeMemoqContentExact(getContentRoot(current));
    }
    await pause(POLL_MS);
  }
  console.warn('[Phrase Bulk Fill] webTrans unconfirmed input', inputState());
  if (observed) {
    throw new Error('The submitted text or native tag positions differ from the translation. Inspect this target before retrying.');
  }
  let delivery = 'The selected editor did not receive an input event.';
  if (received) {
    delivery = 'The editor received an input event but did not render the translation.';
    if (receivedFullValue && input.value === '') {
      delivery = 'The editor received the full translation and cleared its input without rendering the target.';
    } else if (input.value === text) {
      delivery = 'The full translation is still in the editor input buffer.';
    }
  }
  throw new Error('The webTrans target remained empty. ' + delivery);
}
