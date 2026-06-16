import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isGientTransUrl,
  isMemsourceEditorFrameUrl,
  isMemoqUrl,
  isSupportedEditorUrl
} from '../editor-url.ts';

test('GientTrans olEditor URLs are supported editor tabs', () => {
  const url =
    'https://gentrans.genplus.cn/#/olEditor?parentTaskId=2059999499453669378&taskId=2059999499453669378';

  assert.equal(isGientTransUrl(url), true);
  assert.equal(isSupportedEditorUrl(url), true);
});

test('existing Phrase, memsource, and memoQ URL support is preserved', () => {
  assert.equal(isSupportedEditorUrl('https://app.phrase.com/editor/job/123'), true);
  assert.equal(
    isSupportedEditorUrl('https://cloud.memsource.com/web/job/abc/translate'),
    true
  );
  assert.equal(
    isSupportedEditorUrl('https://memoq.example.net/memoqweb/webpm/webtrans/123'),
    true
  );
  assert.equal(isMemoqUrl('https://memoq.example.net/memoqweb/webpm/webtrans/123'), true);
  assert.equal(
    isMemsourceEditorFrameUrl('https://editor.memsource.com/twe/translation/job/abc'),
    true
  );
});

test('non-editor URLs are rejected', () => {
  assert.equal(isSupportedEditorUrl('https://gentrans.genplus.cn/#/login'), false);
  assert.equal(isSupportedEditorUrl('https://example.com/'), false);
  assert.equal(isSupportedEditorUrl(undefined), false);
});
