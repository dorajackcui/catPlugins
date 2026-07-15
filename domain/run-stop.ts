import type { StatusKind } from '../shared/state-types.ts';

export const RUN_STOP_ERROR_MESSAGE = 'Operation stopped by user.';
export const RUN_STOPPED_MESSAGE = 'Stopped.';

export interface RunFailureDescription {
  message: string;
  statusKind: StatusKind;
}

export function describeRunFailure(
  error: unknown,
  fallback: string
): RunFailureDescription {
  const message = error instanceof Error ? error.message : fallback;

  return message === RUN_STOP_ERROR_MESSAGE
    ? { message: RUN_STOPPED_MESSAGE, statusKind: 'default' }
    : { message, statusKind: 'error' };
}
