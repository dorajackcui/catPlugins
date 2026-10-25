import assert from 'node:assert/strict';
import test from 'node:test';

import { isMemsourceEditorFrameUrl } from '../background/editor-url.ts';

test('Phrase frame discovery recognizes Memsource editor frames', () => {
  assert.equal(isMemsourceEditorFrameUrl('https://editor.memsource.com/twe/translation/job/abc'), true);
  assert.equal(isMemsourceEditorFrameUrl('https://cloud.memsource.com/web/job/abc/translate'), false);
  assert.equal(isMemsourceEditorFrameUrl(undefined), false);
});
