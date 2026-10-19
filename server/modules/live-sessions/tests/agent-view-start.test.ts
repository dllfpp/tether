import assert from 'node:assert/strict';
import test from 'node:test';

import { liveSessionsService } from '@/modules/live-sessions/index.js';
import { setSpawnPtyForTests, startJobFromAgentView } from '@/modules/live-sessions/services/live-inject.service.js';
import type { LiveSessionInfo } from '@/shared/types.js';

const TRUST_NO = '\x1b[2K❯ No, exit\r\n  Yes, I trust this folder\r\n';
const TRUST_YES = '\x1b[2K  No, exit\r\n❯ Yes, I trust this folder\r\n';
const AGENT_VIEW = 'Working\r\n❯ describe a task for a new session\r\n';

function job(sessionId: string, cwd: string): LiveSessionInfo {
  return {
    jobId: sessionId.slice(0, 8), kind: 'background', alive: true, pid: 1, name: null,
    status: 'busy', state: 'working', detail: null, cwd, updatedAt: null,
  };
}

type FakeAgentView = { writes: string[]; args: string[] };

/**
 * Fakes agent view: folder question first (which redraws once back to "No"
 * after the first arrow key, like the real menu can), then the task input.
 * Submitting a task makes a new job appear in the live sessions.
 */
function installFakeAgentView(options: { closeOnNo?: boolean } = {}): FakeAgentView {
  const fake: FakeAgentView = { writes: [], args: [] };
  setSpawnPtyForTests(((_file: string, args: string[]) => {
    fake.args = args;
    let emit: ((data: string) => void) | null = null;
    let exitListener: ((event: { exitCode: number }) => void) | null = null;
    let selection: 'no' | 'yes' = 'no';
    let redrawnOnce = false;
    let inAgentView = false;
    setTimeout(() => emit?.(`Quick safety check\r\n${TRUST_NO}`), 20);
    return {
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose() {} };
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exitListener = listener;
        return { dispose() {} };
      },
      write: (data: string) => {
        fake.writes.push(data);
        if (!inAgentView && data === '\x1b[B') {
          selection = 'yes';
          emit?.(TRUST_YES);
          if (!redrawnOnce) {
            redrawnOnce = true;
            selection = 'no';
            setTimeout(() => emit?.(TRUST_NO), 50);
          }
        } else if (!inAgentView && data === '\r') {
          if (selection === 'no') {
            if (options.closeOnNo) exitListener?.({ exitCode: 0 });
            return;
          }
          inAgentView = true;
          setTimeout(() => emit?.(AGENT_VIEW), 50);
        } else if (inAgentView && data === '\r') {
          liveSessionsService.setForTests(new Map([
            ['old-session', job('old-session', '/root')],
            ['new-session-id', job('new-session-id', '/root')],
          ]));
        }
      },
      kill: () => undefined,
    };
  }) as never);
  return fake;
}

test('a new chat starts as a daemon job through agent view, confirming the folder', async () => {
  liveSessionsService.setForTests(new Map([['old-session', job('old-session', '/root')]]));
  const fake = installFakeAgentView();
  try {
    const started = await startJobFromAgentView({ cwd: '/root', prompt: 'ciao\nmondo', model: 'opus', effort: 'high' });
    assert.equal(started.providerSessionId, 'new-session-id');
    assert.deepEqual(fake.args, ['agents', '--model', 'opus', '--effort', 'high']);
    assert.ok(fake.writes.includes('\x1b[200~ciao\nmondo\x1b[201~'));
    // Enter was pressed on the folder question only while "Yes" was selected.
    assert.equal(fake.writes.filter((key) => key === '\x1b[B').length, 2);
    assert.equal(fake.writes.at(-1), '\x03');
  } finally {
    setSpawnPtyForTests(null);
    liveSessionsService.setForTests(new Map());
  }
});

test('unsafe model options are not passed to the CLI', async () => {
  liveSessionsService.setForTests(new Map([['old-session', job('old-session', '/root')]]));
  const fake = installFakeAgentView();
  try {
    await startJobFromAgentView({ cwd: '/root', prompt: 'x', model: 'opus; rm -rf /', effort: null });
    assert.deepEqual(fake.args, ['agents']);
  } finally {
    setSpawnPtyForTests(null);
    liveSessionsService.setForTests(new Map());
  }
});
