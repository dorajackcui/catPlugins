import { runtimeSendMessage } from './chrome-api.ts';
import type { ApiResponse, BackgroundRequest } from './types.ts';

export type TrustedTextWriteRequestType = 'MEMOQ_DEBUGGER_WRITE_TEXT' | 'DEBUGGER_WRITE_TEXT';

export interface TrustedTextWriteOptions {
  requestType: TrustedTextWriteRequestType;
  settleMs?: number;
}

type TrustedTextWriteRequest = Extract<BackgroundRequest, { type: TrustedTextWriteRequestType }>;

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  const setTimer =
    typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);

  return new Promise((resolve) => {
    setTimer(resolve, ms);
  });
}

export async function writeTrustedTextToElement(
  targetElement: HTMLElement,
  text: string,
  options: TrustedTextWriteOptions
): Promise<void> {
  targetElement.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  await delay(options.settleMs ?? 0);

  const rect = targetElement.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Trusted text target element is not visible enough to write.');
  }

  const response = await runtimeSendMessage<TrustedTextWriteRequest, ApiResponse<null>>({
    type: options.requestType,
    payload: {
      x,
      y,
      text
    }
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
}
