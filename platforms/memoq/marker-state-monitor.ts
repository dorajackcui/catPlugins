const STABLE_MATCHES_REQUIRED = 6;
const STABLE_READ_ATTEMPTS = 24;
const STABLE_READ_DELAY_MS = 120;
const EDIT_READ_DELAY_MS = 20;
const EDIT_RENDER_RETRIES = 3;
const FINAL_EXACT_HOLD_MS = 1500;

interface MemoqMarkerStatePort {
  readCurrentValue(): string | null;
  wait?(delayMs: number): Promise<void>;
}

/** Raised before sending input when the re-resolved row has changed. */
export class MemoqMarkerTargetChangedError extends Error {}

/** Exact marker-state verification shared by forward writes and owned Undo steps. */
export class MemoqMarkerStateMonitor {
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(private readonly editor: MemoqMarkerStatePort) {
    this.wait = editor.wait ?? waitForMarkerState;
  }

  /** Give a pending edit a few frames to appear. Once visible, require an
   * uninterrupted series of exact reads before sending another key. */
  async waitForEdit(previous: string, expected: string, stage: string): Promise<void> {
    let observed = this.readState();
    for (let retry = 0; retry < EDIT_RENDER_RETRIES && observed === previous; retry += 1) {
      await this.wait(EDIT_READ_DELAY_MS);
      observed = this.readState();
    }

    for (let matches = 1; observed === expected; matches += 1) {
      if (matches === STABLE_MATCHES_REQUIRED) return;
      await this.wait(EDIT_READ_DELAY_MS);
      observed = this.readState();
    }
    await this.waitForStableValue(expected, stage);
  }

  private readState(): string | null {
    const observed = this.editor.readCurrentValue();
    return observed === null ? null : canonicalMarkerState(observed);
  }

  async waitForExactHold(
    expected: string,
    stage: string
  ): Promise<void> {
    let heldForMs = 0;

    while (heldForMs < FINAL_EXACT_HOLD_MS) {
      if (this.readState() !== expected) {
        throw new Error(`${stage} changed before the hold window completed.`);
      }

      const delayMs = Math.min(
        STABLE_READ_DELAY_MS,
        FINAL_EXACT_HOLD_MS - heldForMs
      );
      await this.wait(delayMs);
      heldForMs += delayMs;
    }

    if (this.readState() !== expected) {
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
      const observed = this.readState();
      if (observed === null) {
        lastObserved = '<target unavailable>';
        consecutiveMatches = 0;
      } else {
        lastObserved = observed;
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
