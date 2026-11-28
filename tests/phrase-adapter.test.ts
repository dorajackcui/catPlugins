import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/types.ts';
import { PhraseAdapter } from '../platforms/phrase/adapter.ts';

function makeSegment(targetElement: HTMLElement): RuntimeSegment {
  return {
    domId: 'segment-position-37', rowNumber: '38', platform: 'phrase',
    sourceRaw: '{name} remains', sourceNormalized: '{name} remains',
    occurrenceIndex: 1, targetRaw: '', isEmptyTarget: true,
    placeholderTokens: ['{name}'], targetElement
  };
}

test('PhraseAdapter requires a validated plan when the source has native markers', async () => {
  const adapter = new PhraseAdapter({} as never);
  const segment = {
    ...makeSegment({} as HTMLElement),
    phraseSourceMarkers: [{ id: 1, token: '{1}', label: '{name}', offset: 0 }]
  };

  const outcome = await adapter.fillSegment(segment, '{name} bleibt');

  assert.equal(outcome.filled, false);
  assert.match(outcome.reason ?? '', /Native Phrase markers require a validated translation/);
});

test('PhraseAdapter fills a generic editable with text and sends its normal update events', async () => {
  const events: string[] = [];
  const target = Object.assign(new EventTarget(), {
    value: '',
    matches: () => false
  });
  target.addEventListener('input', () => events.push('input'));
  const adapter = new PhraseAdapter({
    setEditableValue: (_element: HTMLElement, value: string) => { target.value = value; },
    getGenericEditableValue: () => target.value,
    dispatchChange: () => events.push('change'),
    dispatchBlur: () => events.push('blur')
  } as never);
  const segment = { ...makeSegment(target as unknown as HTMLElement), platform: 'generic' } as const;

  const outcome = await adapter.fillSegment(segment, '{name} bleibt');

  assert.equal(outcome.filled, true);
  assert.equal(target.value, '{name} bleibt');
  assert.deepEqual(events, ['input', 'change', 'blur']);
});
