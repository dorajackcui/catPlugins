import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeEditorPlatform } from '../shared/editor-platform.ts';

test('missing, legacy, and unknown platform preferences require an explicit selection', () => {
  for (const value of [undefined, null, '', 'auto', 'unknown', {}]) {
    assert.equal(normalizeEditorPlatform(value), null);
  }
  for (const value of ['memoq', 'phrase', 'gientrans']) {
    assert.equal(normalizeEditorPlatform(value), value);
  }
});
