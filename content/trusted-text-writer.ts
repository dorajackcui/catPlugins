import { runtimeSendMessage } from '../shared/chrome-api.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  DebuggerInputOperation,
  MemoqDebuggerWriteTextRequest
} from '../shared/message-types.ts';

export interface TrustedTextWriteOptions {
  settleMs?: number;
  resolveElement?: () => HTMLElement | null | undefined;
  requireResolvedElement?: boolean;
}

export interface TrustedInputSequenceOptions extends TrustedTextWriteOptions {
  focusPosition?: 'center' | 'text-start';
  directInput?: {
    locate(element: HTMLElement): { x: number; y: number } | null;
    operations: DebuggerInputOperation[];
  };
}

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
  options: TrustedTextWriteOptions = {}
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

  console.info('[Phrase Bulk Fill]', 'memoQ trusted-write:coordinates', {
    x,
    y,
    width: rect.width,
    height: rect.height,
    textLength: text.length
  });

  const response = await runtimeSendMessage<MemoqDebuggerWriteTextRequest, ApiResponse<null>>({
    type: 'MEMOQ_DEBUGGER_WRITE_TEXT',
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

export async function writeTrustedInputSequenceToElement(
  targetElement: HTMLElement,
  operations: DebuggerInputOperation[],
  options: TrustedInputSequenceOptions = {}
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
      throw new Error('Trusted input sequence target could not be re-resolved safely.');
    }

    return fallback;
  };

  const scrollTarget = await resolveTarget(targetElement);
  scrollTarget.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  await delay(options.settleMs ?? 0);

  const measureTarget = await resolveTarget(scrollTarget);
  const rect = measureTarget.getBoundingClientRect();
  const focusPosition = options.focusPosition ?? 'center';
  const directPoint = options.directInput?.locate(measureTarget);
  const x = directPoint?.x ?? (focusPosition === 'text-start'
    ? rect.left + Math.min(1, rect.width / 2)
    : rect.left + rect.width / 2);
  const y = directPoint?.y ?? (focusPosition === 'text-start'
    ? rect.top + Math.min(7, rect.height / 2)
    : rect.top + rect.height / 2);

  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Trusted input sequence target element is not visible enough to write.');
  }

  const response = await runtimeSendMessage<
    Extract<BackgroundRequest, { type: 'DEBUGGER_INPUT_SEQUENCE' }>,
    ApiResponse<null>
  >({
    type: 'DEBUGGER_INPUT_SEQUENCE',
    payload: {
      x,
      y,
      operations: directPoint && options.directInput ? options.directInput.operations : operations
    }
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
}
