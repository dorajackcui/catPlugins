import { runtimeSendMessage } from '../shared/chrome-api.ts';
import type { ApiResponse, BackgroundRequest } from '../shared/types.ts';

export type TrustedTextWriteRequestType = 'MEMOQ_DEBUGGER_WRITE_TEXT' | 'DEBUGGER_WRITE_TEXT';

export interface TrustedTextWriteOptions {
  requestType: TrustedTextWriteRequestType;
  settleMs?: number;
  resolveElement?: () => HTMLElement | null | undefined;
  requireResolvedElement?: boolean;
}

type TrustedTextWriteRequest = Extract<BackgroundRequest, { type: TrustedTextWriteRequestType }>;
const REQUIRED_RESOLVE_ATTEMPTS = 4;
const REQUIRED_RESOLVE_DELAY_MS = 40;

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
  const resolveTarget = async (fallback: HTMLElement): Promise<HTMLElement> => {
    if (!options.resolveElement) {
      return fallback;
    }

    const attempts = options.requireResolvedElement ? REQUIRED_RESOLVE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const resolved = options.resolveElement();
      if (resolved) {
        return resolved;
      }

      if (attempt < attempts) {
        await delay(REQUIRED_RESOLVE_DELAY_MS);
      }
    }

    if (options.requireResolvedElement) {
      throw new Error('Trusted text target could not be re-resolved safely.');
    }

    return fallback;
  };
  const scrollTarget = await resolveTarget(targetElement);
  scrollTarget.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  await delay(options.settleMs ?? 0);

  const measureTarget = await resolveTarget(scrollTarget);
  const rect = measureTarget.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Trusted text target element is not visible enough to write.');
  }

  if (options.requestType === 'MEMOQ_DEBUGGER_WRITE_TEXT') {
    console.info('[Phrase Bulk Fill]', 'memoQ trusted-write:coordinates', {
      x,
      y,
      width: rect.width,
      height: rect.height,
      textLength: text.length
    });
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
