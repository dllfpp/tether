import assert from 'node:assert/strict';

import { test } from 'vitest';

import { filterProjects, getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { Project } from '@/shared/types';

const project = (projectId: string, displayName: string, titles: string[]): Project => ({
  projectId,
  displayName,
  fullPath: `/root/${projectId}`,
  path: `/root/${projectId}`,
  sessions: titles.map((summary, index) => ({ id: `${projectId}-${index}`, summary, lastActivity: `2026-10-0${index + 1}T10:00:00Z` })),
  sessionMeta: { hasMore: true, total: 40 },
} as unknown as Project);

const projects = [
  project('root', 'root', ['Invoice parser: daily report', 'Dashboard refresh']),
  project('tether', 'Tether', ['Rebrand']),
];

test('a project name match keeps every conversation of the project', () => {
  const [match] = filterProjects(projects, 'tether');
  assert.equal(match.projectId, 'tether');
  assert.equal(getAllSessions(match).length, 1);
});

test('a conversation title match shows its project with only the matching conversations', () => {
  const result = filterProjects(projects, 'invoice');
  assert.equal(result.length, 1);
  assert.equal(result[0].projectId, 'root');
  assert.deepEqual(getAllSessions(result[0]).map((session) => session.summary), ['Invoice parser: daily report']);
  assert.equal(result[0].sessionMeta?.hasMore, false);
});

test('server title matches add conversations the sidebar has not loaded', () => {
  const result = filterProjects(projects, 'billing', [
    { sessionId: 'old-1', provider: 'claude', projectId: 'root', projectDisplayName: 'root', sessionTitle: 'billing docker setup', lastActivity: '2026-09-01T10:00:00Z' },
    // Already loaded, so not listed twice.
    { sessionId: 'root-0', provider: 'claude', projectId: 'root', projectDisplayName: 'root', sessionTitle: 'Invoice parser: daily report', lastActivity: null },
    // A project the sidebar does not show stays out.
    { sessionId: 'x', provider: 'claude', projectId: 'hidden', projectDisplayName: 'hidden', sessionTitle: 'billing', lastActivity: null },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(getAllSessions(result[0]).map((session) => session.id).sort(), ['old-1', 'root-0']);
});

test('nothing matches, nothing is listed', () => {
  assert.equal(filterProjects(projects, 'zzz').length, 0);
});
