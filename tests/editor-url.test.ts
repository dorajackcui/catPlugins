import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isGientTransUrl,
  isMemsourceEditorFrameUrl,
  isMemoqUrl,
  isSupportedEditorUrl
} from '../background/editor-url.ts';

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

test('memoQ webtrans URLs without the webpm segment are supported', () => {
  const url =
    'https://memoq.diezhi.net/memoqweb/webtrans/Translation.aspx?prj=482f20b9-a616-f011-94f4-005056bb3114&doc=3a086802-8779-4e27-b857-15ea2510daf7';

  assert.equal(isMemoqUrl(url), true);
  assert.equal(isSupportedEditorUrl(url), true);
});

test('modern memoQ editor document URLs are supported', () => {
  const url =
    'https://memoq.example.net/memoqweb/editor/projects/project-123/docs/doc-456/?view=translation#row-12';

  assert.equal(isMemoqUrl(url), true);
  assert.equal(isSupportedEditorUrl(url), true);
});

test('non-editor URLs are rejected', () => {
  assert.equal(isSupportedEditorUrl('https://gentrans.genplus.cn/#/login'), false);
  assert.equal(isSupportedEditorUrl('https://example.com/'), false);
  assert.equal(isSupportedEditorUrl(undefined), false);
});
