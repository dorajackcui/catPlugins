import assert from 'node:assert/strict';
import test from 'node:test';

import {
  replaceRuntimeMessageListener,
  type RuntimeListenerState,
  type RuntimeMessageListener
} from '../content/runtime-listener.ts';

test('replaceRuntimeMessageListener removes a previous listener before adding the next one', () => {
  const calls: string[] = [];
  const state: RuntimeListenerState<string, string> = {};
  const first: RuntimeMessageListener<string, string> = () => true;
  const second: RuntimeMessageListener<string, string> = () => true;
  const onMessage = {
    addListener(listener: RuntimeMessageListener<string, string>) {
      calls.push(listener === first ? 'add:first' : 'add:second');
    },
    removeListener(listener: RuntimeMessageListener<string, string>) {
      calls.push(listener === first ? 'remove:first' : 'remove:second');
    }
  };

  replaceRuntimeMessageListener(onMessage, state, first);
  replaceRuntimeMessageListener(onMessage, state, second);

  assert.deepEqual(calls, ['add:first', 'remove:first', 'add:second']);
  assert.equal(state.current, second);
});
