import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_KEYS as directStorageKeys } from '../shared/storage-keys.ts';
import { STORAGE_KEYS as compatibilityStorageKeys } from '../shared/types.ts';

test('shared storage keys preserve persisted state names and compatibility exports', () => {
  assert.equal(compatibilityStorageKeys, directStorageKeys);
  assert.deepEqual(directStorageKeys, {
    translationEntries: 'translation_entries',
    previewResult: 'preview_result',
    uploadMeta: 'upload_meta',
    fillOptions: 'fill_options',
    runState: 'run_state'
  });
});
