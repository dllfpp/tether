import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { PromptSuggestionChip } from '@/modules/live-sessions';

test('the chip shows the suggestion and takes it with one tap', () => {
  let accepted = 0;
  const { getByRole } = render(<PromptSuggestionChip suggestion="fai il deploy" onAccept={() => { accepted += 1; }} />);
  const button = getByRole('button');
  assert.match(button.textContent ?? '', /fai il deploy/);
  fireEvent.click(button);
  assert.equal(accepted, 1);
});

test('no suggestion, no chip', () => {
  const { container } = render(<PromptSuggestionChip suggestion={null} onAccept={() => undefined} />);
  assert.equal(container.textContent, '');
});
