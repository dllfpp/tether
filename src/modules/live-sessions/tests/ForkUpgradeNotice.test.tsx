import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { ForkUpgradeNotice } from '@/modules/live-sessions';

test('the notice offers the request to make, never the upgrade command', () => {
  let closed = 0;
  const { container, getByText } = render(<ForkUpgradeNotice latestVersion="1.39.0" onClose={() => { closed += 1; }} />);
  const text = container.textContent ?? '';
  assert.match(text, /Tether, based on CloudCLI UI/);
  assert.match(text, /v1\.39\.0/);
  assert.doesNotMatch(text, /npm install|git pull/);
  fireEvent.click(getByText('Later'));
  assert.equal(closed, 1);
});
