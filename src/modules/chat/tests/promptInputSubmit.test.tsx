import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { PromptInput, PromptInputSubmit } from '@/modules/chat/composer/PromptInput';

/**
 * PromptInputSubmit used to accept its own `status` prop and fall back to
 * `context?.status ?? 'ready'`. Nothing ever passed the prop and the button is
 * only ever rendered inside PromptInput, so both the prop and the null-context
 * default were unreachable — and the default silently rendered a send button
 * for a composer that was actually streaming.
 *
 * It now reads the root's status through the context, which is the only place
 * the status is ever set.
 */

const renderSubmit = (status: 'ready' | 'streaming', onSubmit = vi.fn(), onClick?: () => void) =>
  render(
    React.createElement(PromptInput, { status, onSubmit },
      React.createElement(PromptInputSubmit, { 'aria-label': 'submit', onClick })),
  );

// CloudCLI live: the composer is no longer a <form> (iOS AutoFill offered
// contacts for its textarea), so the button submits through the root.
test('a ready composer sends when the button is tapped', () => {
  const onSubmit = vi.fn();
  const { getByLabelText, container } = renderSubmit('ready', onSubmit);
  assert.equal(container.querySelector('form'), null, 'no form around the composer');
  fireEvent.click(getByLabelText('submit'));
  assert.equal(onSubmit.mock.calls.length, 1);
});

test('a streaming composer turns the button into a stop control, not a submit', () => {
  const onSubmit = vi.fn();
  const { getByLabelText } = renderSubmit('streaming', onSubmit);
  fireEvent.click(getByLabelText('submit'));
  assert.equal(onSubmit.mock.calls.length, 0);
});

test('a click handled by the caller (queue, stop, voice) does not also send', () => {
  const onSubmit = vi.fn();
  const onClick = vi.fn();
  const { getByLabelText } = renderSubmit('ready', onSubmit, onClick);
  fireEvent.click(getByLabelText('submit'));
  assert.equal(onClick.mock.calls.length, 1);
  assert.equal(onSubmit.mock.calls.length, 0);
});

test('the button cannot be rendered outside PromptInput', () => {
  // React logs the thrown render error; the throw is the assertion here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  assert.throws(
    () => render(React.createElement(PromptInputSubmit, { 'aria-label': 'submit' })),
    /within PromptInput/,
  );
});
