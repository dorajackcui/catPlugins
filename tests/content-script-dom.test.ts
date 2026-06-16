import assert from 'node:assert/strict';
import test from 'node:test';

import { ContentScriptDomHelpers } from '../content-script-dom.ts';

test('element scroll context can move to top and restore the original position', () => {
  const helpers = new ContentScriptDomHelpers();
  const calls: Array<{ top: number; behavior: string }> = [];
  const container = {
    scrollTop: 320,
    clientHeight: 500,
    scrollHeight: 2000,
    scrollBy({ top }: { top: number }) {
      this.scrollTop += top;
    },
    scrollTo({ top, behavior }: { top: number; behavior: string }) {
      calls.push({ top, behavior });
      this.scrollTop = top;
    }
  };

  const context = helpers.toElementScrollContext(container as unknown as HTMLElement);

  context.scrollToTop();
  assert.equal(container.scrollTop, 0);

  context.restore();
  assert.equal(container.scrollTop, 320);
  assert.deepEqual(calls, [
    { top: 0, behavior: 'auto' },
    { top: 320, behavior: 'auto' }
  ]);
});
