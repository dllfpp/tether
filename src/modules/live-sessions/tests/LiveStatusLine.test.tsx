import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { test } from 'vitest';

import { LiveStatusLine } from '@/modules/live-sessions';
import type { LiveSessionInfo } from '@/shared/types';

// Returns the English default so assertions read like the UI.
const t = ((_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key) as unknown as TFunction;

function live(overrides: Partial<LiveSessionInfo>): LiveSessionInfo {
  return {
    jobId: 'abc12345',
    kind: 'background',
    alive: true,
    pid: 1,
    name: 'Job',
    status: 'idle',
    state: 'done',
    detail: null,
    cwd: '/root',
    updatedAt: null,
    ...overrides,
  };
}

function labelOf(info: LiveSessionInfo | null): string {
  const { container } = render(<LiveStatusLine live={info} t={t} />);
  return container.textContent ?? '';
}

test('every job state is spelled out, not only colored', () => {
  assert.match(labelOf(live({ status: 'busy', state: 'working' })), /Working/);
  assert.match(labelOf(live({ state: 'blocked' })), /Waiting for you/);
  assert.match(labelOf(live({ state: 'failed' })), /Failed/);
  assert.match(labelOf(live({ alive: false, pid: null })), /Stopped/);
  assert.match(labelOf(live({})), /Done/);
});

test('a finished job with a background command still running reads Done, not Working', () => {
  assert.match(labelOf(live({ status: 'busy', state: 'done' })), /Done/);
  assert.doesNotMatch(labelOf(live({ status: 'busy', state: 'done' })), /Working/);
  // Without a daemon state, the process flag is all there is.
  assert.match(labelOf(live({ status: 'busy', state: null })), /Working/);
});

test('the job status line follows the state', () => {
  assert.match(labelOf(live({ status: 'busy', state: 'working', detail: 'Deploying to staging' })), /Working\s*·\s*Deploying to staging/);
});

test('terminal sessions show only while their process is alive', () => {
  assert.match(labelOf(live({ kind: 'interactive', jobId: null })), /Open in a terminal/);
  assert.equal(labelOf(live({ kind: 'interactive', jobId: null, alive: false })), '');
  assert.equal(labelOf(null), '');
});
