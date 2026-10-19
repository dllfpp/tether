import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  liveSessionsService,
  refreshAllClaudeSessionNames,
  renameClaudeSession,
  resolveClaudeSessionName,
  syncJobNamesToDb,
} from '@/modules/live-sessions/index.js';
import { readTranscriptTitles } from '@/modules/live-sessions/services/claude-session-names.service.js';
import { setSpawnPtyForTests } from '@/modules/live-sessions/services/live-inject.service.js';
import type { LiveSessionInfo } from '@/shared/types.js';

function info(overrides: Partial<LiveSessionInfo>): LiveSessionInfo {
  return {
    jobId: null,
    kind: 'background',
    alive: true,
    pid: 100,
    name: null,
    status: 'idle',
    state: 'done',
    detail: null,
    cwd: '/root',
    updatedAt: null,
    ...overrides,
  };
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-names-'));
  try {
    await run(dir);
  } finally {
    liveSessionsService.setForTests(new Map());
    await rm(dir, { recursive: true, force: true });
  }
}

test('Claude Code precedence: job name, then custom-title, agent-name, ai-title', async () => {
  await withTempDir(async (dir) => {
    const transcript = path.join(dir, 's.jsonl');
    await writeFile(transcript, [
      line({ type: 'custom-title', customTitle: 'Old name', sessionId: 's' }),
      line({ type: 'ai-title', aiTitle: 'auto title', sessionId: 's' }),
      line({ type: 'user', message: { role: 'user', content: 'hello' } }),
      line({ type: 'custom-title', customTitle: 'Renamed', sessionId: 's' }),
      line({ type: 'agent-name', agentName: 'Agent name', sessionId: 's' }),
    ].join(''));

    assert.deepEqual(await readTranscriptTitles(transcript), { custom: 'Renamed', agent: 'Agent name', ai: 'auto title' });
    assert.equal(await resolveClaudeSessionName('s', transcript), 'Renamed');

    liveSessionsService.setForTests(new Map([['s', info({ jobId: 'job00001', name: 'Job name' })]]));
    assert.equal(await resolveClaudeSessionName('s', transcript), 'Job name');
  });
});

test('without a custom title the agent name, then the ai title, is used', async () => {
  await withTempDir(async (dir) => {
    const transcript = path.join(dir, 't.jsonl');
    await writeFile(transcript, line({ type: 'ai-title', aiTitle: 'auto title', sessionId: 't' }));
    assert.equal(await resolveClaudeSessionName('t', transcript), 'auto title');
    await appendFile(transcript, line({ type: 'agent-name', agentName: 'Agent name', sessionId: 't' }));
    assert.equal(await resolveClaudeSessionName('t', transcript), 'Agent name');
    assert.equal(await resolveClaudeSessionName('t', path.join(dir, 'missing.jsonl')), null);
  });
});

test('titles are found across chunk boundaries in a large transcript', async () => {
  await withTempDir(async (dir) => {
    const transcript = path.join(dir, 'big.jsonl');
    const filler = line({ type: 'assistant', message: { content: 'x'.repeat(2000) } }).repeat(600);
    await writeFile(transcript, line({ type: 'custom-title', customTitle: 'Deep name', sessionId: 'b' }) + filler);
    assert.equal((await readTranscriptTitles(transcript)).custom, 'Deep name');
  });
});

test('a rename of a conversation no process owns is written the way /rename writes it', async () => {
  await withTempDir(async (dir) => {
    const transcript = path.join(dir, 'free.jsonl');
    await writeFile(transcript, '{"type":"user"}'); // no trailing newline on purpose
    await renameClaudeSession({ provider: 'claude', session_id: 'free', provider_session_id: 'free', jsonl_path: transcript }, '  New\nname ');
    const lines = (await readFile(transcript, 'utf8')).trim().split('\n').map((entry) => JSON.parse(entry));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[1], { type: 'custom-title', customTitle: 'New name', sessionId: 'free' });
    assert.deepEqual(lines[2], { type: 'agent-name', agentName: 'New name', sessionId: 'free' });
    assert.equal(await resolveClaudeSessionName('free', transcript), 'New name');
  });
});

test('a rename of a daemon job goes through its own /rename; a terminal session refuses', async () => {
  const writes: string[] = [];
  setSpawnPtyForTests(((_file: string, _args: string[]) => {
    let dataListener: ((data: string) => void) | null = null;
    setTimeout(() => dataListener?.('attached\r\n❯ \r\n← for agents'), 20);
    return {
      onData: (listener: (data: string) => void) => {
        dataListener = listener;
        return { dispose() {} };
      },
      onExit: () => ({ dispose() {} }),
      write: (data: string) => {
        writes.push(data);
      },
      kill: () => undefined,
    };
  }) as never);

  try {
    liveSessionsService.setForTests(new Map([
      ['job-s', info({ jobId: 'job00002', name: 'Before' })],
      ['tty-s', info({ kind: 'interactive' })],
    ]));
    await renameClaudeSession({ provider: 'claude', provider_session_id: 'job-s' }, 'After');
    assert.ok(writes.includes('\x1b[200~/rename After\x1b[201~'));

    await assert.rejects(
      renameClaudeSession({ provider: 'claude', provider_session_id: 'tty-s' }, 'Nope'),
      /open in a terminal/,
    );
  } finally {
    setSpawnPtyForTests(null);
    liveSessionsService.setForTests(new Map());
  }
});

test('a job renamed by the daemon updates the stored name', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-names-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createSession('job-db', 'claude', dir, 'Old', undefined, undefined, path.join(dir, 'job-db.jsonl'));
    liveSessionsService.setForTests(new Map([['job-db', info({ jobId: 'job00003', name: 'New job name' })]]));
    assert.deepEqual(syncJobNamesToDb(['job-db', 'unknown']), ['job-db']);
    assert.equal(sessionsDb.getSessionByProviderSessionId('job-db')?.custom_name, 'New job name');
    assert.deepEqual(syncJobNamesToDb(['job-db']), []);

    // An old conversation stored under its first prompt is realigned once.
    const oldTranscript = path.join(dir, 'old-db.jsonl');
    await writeFile(oldTranscript, line({ type: 'ai-title', aiTitle: 'Claude title', sessionId: 'old-db' }));
    sessionsDb.createSession('old-db', 'claude', dir, 'first prompt text', undefined, undefined, oldTranscript);
    assert.deepEqual(await refreshAllClaudeSessionNames(), ['old-db']);
    assert.equal(sessionsDb.getSessionByProviderSessionId('old-db')?.custom_name, 'Claude title');
    assert.deepEqual(await refreshAllClaudeSessionNames(), []);
  } finally {
    liveSessionsService.setForTests(new Map());
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
