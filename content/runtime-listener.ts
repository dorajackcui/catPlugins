export type RuntimeMessageListener<TRequest, TResponse> = (
  request: TRequest,
  sender: unknown,
  sendResponse: (response: TResponse) => void
) => true;

export interface RuntimeOnMessage<TRequest, TResponse> {
  addListener(listener: RuntimeMessageListener<TRequest, TResponse>): void;
  removeListener(listener: RuntimeMessageListener<TRequest, TResponse>): void;
}

export interface RuntimeListenerState<TRequest, TResponse> {
  current?: RuntimeMessageListener<TRequest, TResponse>;
}

export function replaceRuntimeMessageListener<TRequest, TResponse>(
  onMessage: RuntimeOnMessage<TRequest, TResponse>,
  state: RuntimeListenerState<TRequest, TResponse>,
  listener: RuntimeMessageListener<TRequest, TResponse>
): void {
  if (state.current) {
    onMessage.removeListener(state.current);
  }

  onMessage.addListener(listener);
  state.current = listener;
}
