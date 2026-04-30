import assert from 'node:assert/strict';
import test from 'node:test';

import { getEditorPlatformForUrl, resolvePagePlatform } from '../editor-platform.ts';

test('getEditorPlatformForUrl recognizes legacy memoQ Translation.aspx URLs', () => {
  assert.equal(
    getEditorPlatformForUrl(
      'https://memoq.acme.net/memoqweb/webtrans/Translation.aspx?prj=12345'
    ),
    'memoq'
  );
});

test('getEditorPlatformForUrl recognizes memoQ webpm webtrans URLs', () => {
  assert.equal(
    getEditorPlatformForUrl(
      'https://memoq.acme.net/memoqweb/webpm/webtrans/project/segment?prj=12345'
    ),
    'memoq'
  );
});

test('getEditorPlatformForUrl recognizes Phrase editor URLs', () => {
  assert.equal(getEditorPlatformForUrl('https://app.phrase.com/editor/abc123'), 'phrase');
});

test('resolvePagePlatform keeps memoQ on the memoQ route even without editor cells', () => {
  assert.equal(
    resolvePagePlatform(
      'https://memoq.tenant.net/memoqweb/webpm/webtrans/project/segment?prj=67890',
      false
    ),
    'memoq'
  );
});

test('resolvePagePlatform can still infer memoQ from editor cells when the URL is ambiguous', () => {
  assert.equal(resolvePagePlatform('https://example.com/other-page', true), 'memoq');
});
