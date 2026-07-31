import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasMemoqInlineTagMarkup,
  memoqProtectedSourceMatchesExcelSource
} from '../domain/memoq-markup.ts';

test('memoQ protected markers match their original Excel source spans', () => {
  const excelSource =
    '1. 活动期间。\\r\\n2. 搭配师可自由选择。\\r\\n3. 若已解锁。\\r\\n4. 可以补购。\\r\\n5. 获得权益。';
  const memoqSource =
    '1. 活动期间。\\r{1>2. 搭配师可自由选择。\\r{1>3. 若已解锁。\\r{1>4. 可以补购。\\r{1>5. 获得权益。';

  assert.equal(hasMemoqInlineTagMarkup(memoqSource), true);
  assert.equal(
    memoqProtectedSourceMatchesExcelSource(memoqSource, excelSource),
    true
  );
});

test('memoQ protected markers match literal escaped CRLF text from the source workbook', () => {
  const excelSource = String.raw`1. 活动期间，在【此途生辉】购买礼包的搭配师，将直接解锁礼包对应的当期【悠远颂歌】或【奇迹史诗】。\r\n2. 搭配师可自由选择购买【金辉颂歌】、【辉途史诗】任一礼包。请注意，若已购买【金辉颂歌】或【辉途史诗】其中一个礼包，则不可再购买另一个礼包。\r\n3. 若搭配师已在奇迹之旅解锁当期【悠远颂歌】，可以在商城补购【金辉颂歌】除【悠远颂歌】外的其他奖励；或按原价升级【奇迹史诗】后，在商城补购【辉途史诗】除【奇迹史诗】外的其他奖励。\r\n4. 若搭配师已在奇迹之旅解锁当期【奇迹史诗】，可以在商城补购【辉途史诗】除【奇迹史诗】外的其他奖励。\r\n5. 获得的【满月回馈】权益可在背包-消耗品找到使用；【满月回馈】权益在使用激活后仅可获得除【无垠星石】以外的权益，无法再次获得【无垠星石】。`;
  const memoqSource = String.raw`1. 活动期间，在【此途生辉】购买礼包的搭配师，将直接解锁礼包对应的当期【悠远颂歌】或【奇迹史诗】。\r{1>2. 搭配师可自由选择购买【金辉颂歌】、【辉途史诗】任一礼包。请注意，若已购买【金辉颂歌】或【辉途史诗】其中一个礼包，则不可再购买另一个礼包。\r{1>3. 若搭配师已在奇迹之旅解锁当期【悠远颂歌】，可以在商城补购【金辉颂歌】除【悠远颂歌】外的其他奖励；或按原价升级【奇迹史诗】后，在商城补购【辉途史诗】除【奇迹史诗】外的其他奖励。\r{1>4. 若搭配师已在奇迹之旅解锁当期【奇迹史诗】，可以在商城补购【辉途史诗】除【奇迹史诗】外的其他奖励。\r{1>5. 获得的【满月回馈】权益可在背包-消耗品找到使用；【满月回馈】权益在使用激活后仅可获得除【无垠星石】以外的权益，无法再次获得【无垠星石】。`;

  assert.equal(
    memoqProtectedSourceMatchesExcelSource(memoqSource, excelSource),
    true
  );
});

test('memoQ protected-source matching still rejects changed visible text', () => {
  assert.equal(
    memoqProtectedSourceMatchesExcelSource(
      'Before{1>Visible after',
      'Before<protected>Different after'
    ),
    false
  );
});

test('memoQ protected-source matching refuses an unbounded protected span', () => {
  assert.equal(
    memoqProtectedSourceMatchesExcelSource(
      'Before{1>After',
      `Before${'x'.repeat(257)}After`
    ),
    false
  );
});
