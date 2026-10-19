import assert from 'node:assert/strict';
import test from 'node:test';

import { questionKeys } from '@/modules/live-sessions/services/live-inject.service.js';

const colour = { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] };
const fruit = { question: 'Fruit?', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Grape' }] };

test('a single choice is its option number; typed text goes through "Type something"', () => {
  assert.deepEqual(questionKeys([colour], { 'Colour?': 'Green' }), { keys: ['2'] });
  assert.deepEqual(questionKeys([colour], { 'Colour?': 'Turquoise' }), { keys: ['4', 'Turquoise', '\r'] });
});

test('a multiple choice ticks each option, then Tab moves on', () => {
  assert.deepEqual(
    questionKeys([fruit, colour], { 'Fruit?': 'Apple, Grape', 'Colour?': 'Red' }),
    { keys: ['1', '3', '\t', '1'] },
  );
});

test('typed text in a multiple choice, or a missing answer, is refused', () => {
  assert.ok('error' in questionKeys([fruit], { 'Fruit?': 'Apple, Kiwi' }));
  assert.ok('error' in questionKeys([colour], {}));
});
