import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  isHiddenProjectPath,
  liveSessionsService,
  loginRateLimit,
  resolveLiveRoute,
} from '@/modules/live-sessions/index.js';
import { sanitizeForPaste, setSpawnPtyForTests } from '@/modules/live-sessions/services/live-inject.service.js';
import { mergeLiveSources } from '@/modules/live-sessions/services/live-sessions.service.js';
import { resetLoginRateLimitForTests } from '@/modules/live-sessions/login-rate-limit.middleware.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
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

test('merge: job state fills name and status line, agents fill pid and activity', () => {
  const merged = mergeLiveSources(
    [{ pid: 42, id: 'abc12345', kind: 'background', sessionId: 's-1', status: 'busy', state: 'working', cwd: '/root' }],
    [{ daemonShort: 'abc12345', sessionId: 's-1', name: 'VPN', state: 'working', detail: 'Deploying' }],
  );
  const entry = merged.get('s-1');
  assert.equal(entry?.jobId, 'abc12345');
  assert.equal(entry?.alive, true);
  assert.equal(entry?.pid, 42);
  assert.equal(entry?.name, 'VPN');
  assert.equal(entry?.detail, 'Deploying');
  assert.equal(entry?.status, 'busy');
});

test('merge: a job with no process is known but not alive', () => {
  const merged = mergeLiveSources([], [{ daemonShort: 'dead0001', sessionId: 's-2', state: 'done' }]);
  assert.equal(merged.get('s-2')?.alive, false);
  assert.equal(merged.get('s-2')?.jobId, 'dead0001');
});

test('merge: claude-mem observer sessions are dropped', () => {
  const observerCwd = path.join(os.homedir(), '.claude-mem', 'observer-sessions', '9');
  const merged = mergeLiveSources([{ pid: 7, kind: 'interactive', sessionId: 'obs', cwd: observerCwd }], []);
  assert.equal(merged.has('obs'), false);
  assert.equal(isHiddenProjectPath(observerCwd), true);
  assert.equal(isHiddenProjectPath('/root/notes'), false);
});

test('route: jobs, terminals and free conversations', () => {
  liveSessionsService.setForTests(new Map([
    ['job-session', info({ jobId: 'job00001' })],
    ['stopped-job', info({ jobId: 'job00002', alive: false, pid: null })],
    ['tty-session', info({ kind: 'interactive', jobId: null })],
    ['old-tty', info({ kind: 'interactive', jobId: null, alive: false })],
  ]));

  assert.equal(resolveLiveRoute({ provider: 'claude', provider_session_id: 'job-session' }).mode, 'job');
  // A stopped job is still a job: attaching restarts it under the same id.
  assert.equal(resolveLiveRoute({ provider: 'claude', provider_session_id: 'stopped-job' }).mode, 'job');
  assert.equal(resolveLiveRoute({ provider: 'claude', provider_session_id: 'tty-session' }).mode, 'interactive');
  assert.equal(resolveLiveRoute({ provider: 'claude', provider_session_id: 'old-tty' }).mode, 'none');
  assert.equal(resolveLiveRoute({ provider: 'claude', provider_session_id: 'unknown' }).mode, 'none');
  assert.equal(resolveLiveRoute({ provider: 'codex', provider_session_id: 'job-session' }).mode, 'none');

  liveSessionsService.setForTests(new Map());
});

test('paste text cannot carry escape sequences or control keys', () => {
  assert.equal(sanitizeForPaste('a\r\nb\x1b[201~c\x03'), 'a\nb[201~c');
});

type FakeTerm = {
  writes: string[];
  args: string[];
};

function installFakePty(): FakeTerm {
  const fake: FakeTerm = { writes: [], args: [] };
  setSpawnPtyForTests(((file: string, args: string[]) => {
    fake.args = [file, ...args];
    let dataListener: ((data: string) => void) | null = null;
    setTimeout(() => dataListener?.('attached view\r\n❯ \r\n← for agents'), 20);
    return {
      onData: (listener: (data: string) => void) => {
        dataListener = listener;
        return { dispose() {} };
      },
      onExit: () => ({ dispose() {} }),
      write: (data: string) => {
        fake.writes.push(data);
      },
      kill: () => undefined,
    };
  }) as never);
  return fake;
}

test('a turn for a daemon job goes into the job, never through the provider runtime', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'live-sessions-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const fake = installFakePty();
  const runs: string[] = [];
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, command: string) => {
      runs.push(command);
    },
    abort: async () => true,
    resolveToolApproval: () => undefined,
    getPendingApprovalsForSession: () => [],
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
  };

  try {
    sessionsDb.createAppSession('app-job', 'claude', tempDirectory, 'Job');
    sessionsDb.createAppSession('app-tty', 'claude', tempDirectory, 'Terminal');
    liveSessionsService.setForTests(new Map([
      ['app-job', info({ jobId: 'job00003' })],
      ['app-tty', info({ kind: 'interactive' })],
    ]));

    const delivered = await runDetachedChatTurn(
      { sessionId: 'app-job', userId: null, content: 'riga uno\nriga due' },
      { runtime },
    );
    assert.equal(delivered.started, true);
    assert.deepEqual(runs, []);
    assert.deepEqual(fake.args.slice(1), ['attach', 'job00003']);
    assert.ok(fake.writes.includes('\x1b[200~riga uno\nriga due\x1b[201~'));
    assert.ok(fake.writes.includes('\r'));

    const refused = await runDetachedChatTurn(
      { sessionId: 'app-tty', userId: null, content: 'hello' },
      { runtime },
    );
    assert.equal(refused.started, false);
    assert.deepEqual(runs, []);
  } finally {
    setSpawnPtyForTests(null);
    liveSessionsService.setForTests(new Map());
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// Guards the upstream hook points this fork depends on: a rebase that moves
// them must fail here rather than silently reopen the split-session path.
test('upstream hook points are still wired', async () => {
  const root = path.resolve(import.meta.dirname, '../../../..');
  const chat = await readFile(path.join(root, 'server/modules/websocket/services/chat-websocket.service.ts'), 'utf8');
  const sendBody = chat.slice(chat.indexOf('async function handleChatSend'), chat.indexOf('type ResolvedSendTarget'));
  assert.ok(sendBody.indexOf('deliverLiveTurn') > -1 && sendBody.indexOf('deliverLiveTurn') < sendBody.indexOf('dispatchRun'));
  const liveTurnBody = chat.slice(chat.indexOf('async function deliverLiveTurn'));
  assert.match(liveTurnBody, /startChatAsJob\(/);

  const shell = await readFile(path.join(root, 'server/modules/websocket/services/shell-websocket.service.ts'), 'utf8');
  assert.match(shell, /claude attach/);

  const broadcast = await readFile(path.join(root, 'server/modules/websocket/services/session-upsert-broadcast.service.ts'), 'utf8');
  assert.match(broadcast, /liveSessionsService\.get/);

  const synchronizer = await readFile(path.join(root, 'server/modules/providers/list/claude/claude-session-synchronizer.provider.ts'), 'utf8');
  assert.match(synchronizer, /resolveClaudeSessionName\(/);

  const sessions = await readFile(path.join(root, 'server/modules/providers/services/sessions.service.ts'), 'utf8');
  const renameBody = sessions.slice(sessions.indexOf('async renameSessionById'));
  assert.ok(renameBody.indexOf('renameClaudeSession') > -1 && renameBody.indexOf('renameClaudeSession') < renameBody.indexOf('updateSessionCustomName'));
});

test('login limiter blocks an IP after repeated failures', async () => {
  resetLoginRateLimitForTests();

  const attempt = (status: number) => new Promise<number>((resolve) => {
    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value; },
      status(code: number) { this.statusCode = code; return this; },
      json(_body: unknown) { resolve(this.statusCode); return this; },
    };
    const req = { method: 'POST', ip: '10.9.9.9', socket: {} };
    loginRateLimit(req as never, res as never, () => {
      res.status(status).json({});
    });
  });

  assert.equal(await attempt(200), 200);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await attempt(401), 401);
  }
  assert.equal(await attempt(200), 429);
  resetLoginRateLimitForTests();
});

// Regression: a job woken by attach prints "Waking session…" and goes quiet
// while it reloads; pasting then lost the message.
test('a waking job is not taken for ready', async () => {
  const { isPromptDrawn } = await import('@/modules/live-sessions/services/live-inject.service.js');
  assert.equal(isPromptDrawn('Waking session d5bd31bb…\r\n\r\n  Attaching…\r\n'), false);
  assert.equal(isPromptDrawn('● OK\r\n────\r\n❯ \r\n⏵⏵ auto mode on · ← for agents'), true);
  // History replayed while waking already shows past prompts with ❯.
  assert.equal(isPromptDrawn('Waking session…\r\n❯ yes, point the dashboard button\r\n● done'), false);
});

// A job mid-turn never goes quiet, so it is recognised by its busy footer.
test('a job that is still working is ready to take a queued message', async () => {
  const { isBusyPromptDrawn } = await import('@/modules/live-sessions/services/live-inject.service.js');
  assert.equal(isBusyPromptDrawn('Attaching…\r\n✻ Gallivanting… (12s · ↓ 3k tokens · esc to interrupt)\r\n❯ '), true);
  // Not before the attach notice: replayed history is not the live footer.
  assert.equal(isBusyPromptDrawn('esc to interrupt\r\nWaking session…\r\n'), false);
  assert.equal(isBusyPromptDrawn('Attaching…\r\n❯ \r\n← for agents'), false);
});
