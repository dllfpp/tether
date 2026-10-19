import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import TypedConfirmStep from '@/modules/sidebar/TypedConfirmStep';

afterEach(() => {
  vi.useRealTimers();
});

const renderStep = (onConfirm = vi.fn()) => ({
  onConfirm,
  ...render(React.createElement(TypedConfirmStep, {
    action: 'delete',
    targetName: 'My project',
    consequence: 'Gone for good.',
    onConfirm,
    onBack: vi.fn(),
  })),
});

const finalButton = (getByText: (text: RegExp) => HTMLElement) => (
  getByText(/Delete permanently/).closest('button') as HTMLButtonElement
);

test('the button stays locked until the exact phrase is typed and the delay passes', () => {
  vi.useFakeTimers();
  const { getByLabelText, getByText, onConfirm } = renderStep();
  const input = getByLabelText(/To confirm, type/);

  fireEvent.change(input, { target: { value: 'delete my project' } });
  act(() => { vi.advanceTimersByTime(6000); });
  assert.equal(finalButton(getByText).disabled, true, 'case must match');

  fireEvent.change(input, { target: { value: 'delete My project' } });
  assert.equal(finalButton(getByText).disabled, false);
  fireEvent.click(finalButton(getByText));
  assert.equal(onConfirm.mock.calls.length, 1);
});

test('typing the phrase at once still waits for the countdown', () => {
  vi.useFakeTimers();
  const { getByLabelText, getByText, onConfirm } = renderStep();
  fireEvent.change(getByLabelText(/To confirm, type/), { target: { value: 'delete My project' } });
  assert.equal(finalButton(getByText).disabled, true);
  fireEvent.click(finalButton(getByText));
  assert.equal(onConfirm.mock.calls.length, 0);
});

test('paste is refused', () => {
  const { getByLabelText } = renderStep();
  const input = getByLabelText(/To confirm, type/);
  const event = new Event('paste', { bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});
