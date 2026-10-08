const STABLE_MATCHES_REQUIRED = 6;
const STABLE_READ_ATTEMPTS = 24;
const STABLE_READ_DELAY_MS = 120;
const FINAL_EXACT_HOLD_MS = 1500;

interface MemoqMarkerStatePort {
  readCurrentValue(): string | null;
  wait?(delayMs: number): Promise<void>;
}

/** Exact marker-state verification shared by forward writes and owned Undo steps. */
export class MemoqMarkerStateMonitor {
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(private readonly editor: MemoqMarkerStatePort) {
    this.wait = editor.wait ?? waitForMarkerState;
  }

  async waitForExactHold(
    expected: string,
    stage: string
  ): Promise<void> {
    let heldForMs = 0;

    while (heldForMs < FINAL_EXACT_HOLD_MS) {
      const observed = this.editor.readCurrentValue();
      if (
        observed === null ||
        canonicalMarkerState(observed) !== expected
      ) {
        throw new Error(`${stage} changed before the hold window completed.`);
      }

      const delayMs = Math.min(
        STABLE_READ_DELAY_MS,
        FINAL_EXACT_HOLD_MS - heldForMs
      );
      await this.wait(delayMs);
      heldForMs += delayMs;
    }

    const finalObserved = this.editor.readCurrentValue();
    if (
      finalObserved === null ||
      canonicalMarkerState(finalObserved) !== expected
    ) {
      throw new Error(`${stage} changed at the end of the hold window.`);
    }
  }

  async waitForStableValue(
    expected: string,
    stage: string
  ): Promise<void> {
    let consecutiveMatches = 0;
    let lastObserved = '';

    for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
      const observed = this.editor.readCurrentValue();
      if (observed === null) {
        lastObserved = '<target unavailable>';
        consecutiveMatches = 0;
      } else {
        lastObserved = canonicalMarkerState(observed);
        consecutiveMatches =
          lastObserved === expected ? consecutiveMatches + 1 : 0;
      }

      if (consecutiveMatches >= STABLE_MATCHES_REQUIRED) {
        return;
      }

      if (attempt < STABLE_READ_ATTEMPTS) {
        await this.wait(STABLE_READ_DELAY_MS);
      }
    }

    throw new Error(
      `${stage} did not stabilize. Expected ${JSON.stringify(expected)}, observed ${JSON.stringify(lastObserved)}.`
    );
  }
}

export function canonicalMarkerState(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function waitForMarkerState(delayMs: number): Promise<void> {
  const setTimer =
    typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);

  return new Promise((resolve) => {
    setTimer(resolve, delayMs);
  });
}
