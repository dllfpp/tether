import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  archiveDeletedJobSessions,
  liveSessionsService,
  removeClaudeJobForSession,
} from '@/modules/live-sessions/index.js';
import type { LiveSessionInfo } from '@/shared/types.js';

async function withIsolatedState(run: (dir: string) => Promise<void>): Promise<void> {
  const previous = { db: process.env.DATABASE_PATH, cli: process.env.CLAUDE_CLI_PATH };
  const dir = await mkdtemp(path.join(tmpdir(), 'job-lifecycle-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await run(dir);
  } finally {
    liveSessionsService.setForTests(new Map());
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', previous.db], ['CLAUDE_CLI_PATH', previous.cli]] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const agent = (sessionId: string) => ({ pid: 1, id: sessionId.slice(0, 8), kind: 'background', sessionId, status: 'idle', state: 'done', cwd: '/root' });
const jobState = (sessionId: string) => ({ daemonShort: sessionId.slice(0, 8), sessionId, name: sessionId, state: 'done' });

test('a job deleted in Claude Code is reported after two complete reads, and archived', async () => {
  await withIsolatedState(async () => {
    const deleted: string[][] = [];
    const stop = liveSessionsService.onJobsDeleted((ids) => deleted.push(ids));
    try {
      sessionsDb.createSession('job-a', 'claude', '/root', 'A');
      sessionsDb.createSession('job-b', 'claude', '/root', 'B');

      await liveSessionsService.applySources([agent('job-a'), agent('job-b')], [jobState('job-a'), jobState('job-b')]);
      await liveSessionsService.applySources([agent('job-a')], [jobState('job-a')]);
      assert.deepEqual(deleted, [], 'one miss is not enough');
      await liveSessionsService.applySources([agent('job-a')], [jobState('job-a')]);
      assert.deepEqual(deleted, [['job-b']]);

      assert.deepEqual(archiveDeletedJobSessions(['job-b', 'never-seen']), ['job-b']);
      assert.equal(sessionsDb.getSessionByProviderSessionId('job-b')?.isArchived, 1);
      assert.equal(sessionsDb.getSessionByProviderSessionId('job-a')?.isArchived, 0);
      assert.deepEqual(archiveDeletedJobSessions(['job-b']), [], 'already archived');

      // The known-jobs list survives restarts.
      const known = JSON.parse(await readFile(path.join(path.dirname(process.env.DATABASE_PATH!), 'live-known-jobs.json'), 'utf8'));
      assert.deepEqual(known, ['job-a']);
    } finally {
      stop();
    }
  });
});

test('many jobs vanishing at once is treated as a broken read, not as deletions', async () => {
  await withIsolatedState(async () => {
    const deleted: string[][] = [];
    const stop = liveSessionsService.onJobsDeleted((ids) => deleted.push(ids));
    try {
      const ids = Array.from({ length: 8 }, (_, index) => `bulk-${index}`);
      await liveSessionsService.applySources(ids.map(agent), ids.map(jobState));
      await liveSessionsService.applySources([], []);
      await liveSessionsService.applySources([], []);
      assert.deepEqual(deleted, []);
    } finally {
      stop();
    }
  });
});

test('deleting a job conversation in the app runs claude rm; a terminal one is refused', async () => {
  await withIsolatedState(async (dir) => {
    const argsFile = path.join(dir, 'cli-args.txt');
    const fakeCli = path.join(dir, 'fake-claude.sh');
    await writeFile(fakeCli, `#!/bin/sh\necho "$@" > ${argsFile}\n`);
    await chmod(fakeCli, 0o755);
    process.env.CLAUDE_CLI_PATH = fakeCli;

    const info = (overrides: Partial<LiveSessionInfo>): LiveSessionInfo => ({
      jobId: 'job00042', kind: 'background', alive: true, pid: 1, name: null, status: 'idle',
      state: 'done', detail: null, cwd: '/root', updatedAt: null, ...overrides,
    });
    liveSessionsService.setForTests(new Map([
      ['job-x', info({})],
      ['tty-x', info({ kind: 'interactive', jobId: null })],
    ]));

    await removeClaudeJobForSession({ provider: 'claude', provider_session_id: 'job-x' });
    assert.equal((await readFile(argsFile, 'utf8')).trim(), 'rm job00042');

    await assert.rejects(removeClaudeJobForSession({ provider: 'claude', provider_session_id: 'tty-x' }), /open in a terminal/);
    // Not a job: nothing to remove in Claude Code.
    await removeClaudeJobForSession({ provider: 'claude', provider_session_id: 'plain' });
  });
});

test('hidden folders stay out of the recent conversations feed, with exact pagination', async () => {
  await withIsolatedState(async () => {
    sessionsDb.createSession('visible-1', 'claude', '/root', 'one');
    sessionsDb.createSession('observer-1', 'claude', '/root/.claude-mem/observer-sessions/9', 'obs');
    sessionsDb.createSession('visible-2', 'claude', '/root/project', 'two');

    const page = sessionsDb.getRecentSessionsPage(10, 0, ['/root/.claude-mem/observer-sessions']);
    assert.deepEqual(page.sessions.map((session) => session.session_id).sort(), ['visible-1', 'visible-2']);
    assert.equal(page.total, 2);
    assert.equal(sessionsDb.getRecentSessionsPage(10, 0).total, 3);
  });
});
