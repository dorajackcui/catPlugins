import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebTransExportReader } from '../platforms/memoq/webtrans-export-rows.ts';
import { fakeDocument, fakeElement } from './memoq-test-dom.ts';

function row(position: number, number: string, pending = false): HTMLElement {
  return fakeElement({
    tagName: 'TR',
    attributes: { 'data-id': String(position) },
    className: pending ? 'not-loaded-row' : '',
    children: [fakeElement({ className: 'order', textContent: number + '.' })]
  }) as unknown as HTMLElement;
}

test('webTrans export redraws numbered placeholders and restores the tag display before reading', async () => {
  for (const initiallySelected of [true, false]) {
    let selected = initiallySelected;
    let clicks = 0;
    let visible = [row(0, '173', true)];
    const toggle = fakeElement({ id: 'gridBtnLongInlineTag' });
    toggle.classList.contains = token => token === 'selected' && selected;
    Object.assign(toggle, { click() {
      selected = !selected;
      clicks++;
      visible = [row(0, '173')];
    } });
    const doc = fakeDocument(fakeElement({ children: [toggle] }));
    const read = createWebTransExportReader(doc, () => visible, async () => false);
    assert.deepEqual(await read(() => {}), ['173']);
    assert.equal(clicks, 2);
    assert.equal(selected, initiallySelected);
    assert.deepEqual(await read(() => {}), ['173']);
    assert.equal(clicks, 2);
  }
});

test('webTrans export backs up to a skipped filtered position while preserving sparse document numbers', async () => {
  let visible = [row(0, '3'), row(1, '173')];
  let backSteps = 0;
  const read = createWebTransExportReader(fakeDocument(fakeElement({})), () => visible, async () => {
    backSteps++;
    visible = [row(2, '176'), row(3, '45600')];
    return true;
  });
  assert.deepEqual(await read(() => {}), ['3', '173']);
  visible = [row(3, '45600')];
  assert.deepEqual(await read(() => {}), ['176', '45600']);
  assert.equal(backSteps, 1);
  visible = [row(3, '42')];
  assert.equal(await read(() => {}).catch(error => error.message),
    'The filtered memoQ row order changed before row 42. No workbook was created.');
});

test('webTrans export refuses a row that remains unloaded even on the final screen', async () => {
  const read = createWebTransExportReader(fakeDocument(fakeElement({})), () => [row(0, '173', true)], async () => false);
  assert.equal(await read(() => {}).catch(error => error.message),
    'memoQ has not loaded row 173. No workbook was created.');
});
