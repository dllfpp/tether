import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';
import { MoveSessionProvider, useMoveSessionRequest } from '@/modules/sidebar/MoveSessionModal';

afterEach(() => {
  vi.restoreAllMocks();
});

const project = (projectId: string, displayName: string, lastActivity: string): Project => ({
  projectId,
  displayName,
  fullPath: `/root/${projectId}`,
  path: `/root/${projectId}`,
  sessions: [{ id: `${projectId}-s`, summary: 's', lastActivity }],
} as unknown as Project);

const projects = [
  project('root', 'root', '2026-10-09T10:00:00Z'),
  project('zeta', 'Zeta', '2026-10-09T12:00:00Z'),
  project('alpha', 'Alpha', '2026-10-01T10:00:00Z'),
];

function Opener() {
  const requestMove = useMoveSessionRequest();
  return (
    <button type="button" onClick={() => requestMove?.({ sessionId: 'chat-1', sessionName: 'Invoice parser', projectId: 'root' })}>
      open
    </button>
  );
}

const renderModal = (onMoved = vi.fn()) => {
  render(
    <MoveSessionProvider projects={projects} onMoved={onMoved}>
      <Opener />
    </MoveSessionProvider>,
  );
  fireEvent.click(screen.getByText('open'));
  return onMoved;
};

const listedNames = () => screen.getAllByRole('option').map((option) => option.querySelector('span')?.textContent);

test('lists every other project, alphabetically or newest first, and filters by search', () => {
  renderModal();
  assert.deepEqual(listedNames(), ['Alpha', 'Zeta'], 'the current project is not offered');

  fireEvent.click(screen.getByRole('button', { name: 'Newest' }));
  assert.deepEqual(listedNames(), ['Zeta', 'Alpha']);

  fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'alp' } });
  assert.deepEqual(listedNames(), ['Alpha']);
});

test('moving to an existing project sends its path and reloads the sidebar', async () => {
  const move = vi.spyOn(api, 'moveSessionToProject').mockResolvedValue(new Response('{}', { status: 200 }));
  const onMoved = renderModal();

  fireEvent.click(screen.getByText('Zeta'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  });

  assert.deepEqual(move.mock.calls[0], ['chat-1', { projectPath: '/root/zeta' }]);
  assert.equal(onMoved.mock.calls.length, 1);
  assert.equal(screen.queryByRole('dialog'), null, 'the modal closes after the move');
});

test('a new project is named by the user, and a refused move shows the reason', async () => {
  const body = JSON.stringify({ error: { message: 'Claude is still working in this conversation.' } });
  const move = vi.spyOn(api, 'moveSessionToProject').mockResolvedValue(new Response(body, { status: 409 }));
  renderModal();

  fireEvent.click(screen.getByRole('tab', { name: /new project/i }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'invoice tool' } });
  assert.ok(screen.getByText('~/invoice-tool'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create and move' }));
  });

  assert.deepEqual(move.mock.calls[0], ['chat-1', { newProjectName: 'invoice tool' }]);
  assert.ok(screen.getByRole('alert').textContent?.includes('still working'));
  assert.ok(screen.getByRole('dialog'), 'the modal stays open on a refusal');
});
