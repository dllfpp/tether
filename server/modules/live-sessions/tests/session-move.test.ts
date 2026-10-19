import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { liveSessionsService } from '@/modules/live-sessions/index.js';
import {
  encodeClaudeProjectPath,
  moveSessionToProject,
  newProjectPathFor,
  rewriteTranscriptCwd,
} from '@/modules/live-sessions/services/session-move.service.js';
import type { LiveSessionInfo } from '@/shared/types.js';

const SESSION = '11111111-2222-3333-4444-555555555555';

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'session-move-'));
  const previous = { home: process.env.HOME, db: process.env.DATABASE_PATH };
  closeConnection();
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  try {
    await run(home);
  } finally {
    liveSessionsService.setForTests(new Map());
    closeConnection();
    process.env.HOME = previous.home;
    if (previous.db === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous.db;
    await rm(home, { recursive: true, force: true });
  }
}

/** A root-project conversation with a side folder, as Claude Code lays it out. */
async function seedConversation(home: string): Promise<{ fromCwd: string; jsonl: string; side: string }> {
  const fromCwd = home;
  const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectPath(fromCwd));
  await mkdir(path.join(dir, SESSION), { recursive: true });
  await writeFile(path.join(dir, SESSION, 'note.txt'), 'side');
  const jsonl = path.join(dir, `${SESSION}.jsonl`);
  await writeFile(jsonl, [
    JSON.stringify({ type: 'user', cwd: fromCwd, sessionId: SESSION }),
    'not json at all',
    JSON.stringify({ type: 'assistant', cwd: `${fromCwd}/sub`, sessionId: SESSION }),
    '',
  ].join('\n'));
  projectsDb.createProjectPath(fromCwd, 'root');
  sessionsDb.createSession(SESSION, 'claude', fromCwd, 'Invoice parser', undefined, undefined, jsonl);
  return { fromCwd, jsonl, side: path.join(dir, SESSION) };
}

const exists = async (target: string) => stat(target).then(() => true, () => false);

test('only exact cwd values move; other lines stay byte for byte', () => {
  const text = ['{"cwd":"/root","a":1}', '{"cwd":"/root/sub"}', 'garbage {"cwd"', ''].join('\n');
  const moved = rewriteTranscriptCwd(text, '/root', '/root/invoices').split('\n');
  assert.deepEqual(JSON.parse(moved[0]), { cwd: '/root/invoices', a: 1 });
  assert.equal(moved[1], '{"cwd":"/root/sub"}');
  assert.equal(moved[2], 'garbage {"cwd"');
  assert.equal(moved.length, 4);
});

test('a new project name becomes a folder in the home directory, and odd names are refused', () => {
  assert.equal(path.basename(newProjectPathFor('Invoice tool')), 'Invoice-tool');
  assert.throws(() => newProjectPathFor('../etc'), /letters, digits/);
  assert.throws(() => newProjectPathFor(''), /letters, digits/);
});

test('moving to a new project rewrites cwd, moves the side folder and removes the originals', async () => {
  await withHome(async (home) => {
    const { jsonl, side } = await seedConversation(home);

    const result = await moveSessionToProject({ sessionId: SESSION, newProjectName: 'invoice-tool' });

    const toCwd = path.join(home, 'invoice-tool');
    assert.equal(result.projectPath, toCwd);
    assert.ok(result.projectId);
    const lines = (await readFile(result.jsonlPath, 'utf8')).split('\n');
    assert.equal(JSON.parse(lines[0]).cwd, toCwd);
    assert.equal(lines[1], 'not json at all');
    assert.equal(JSON.parse(lines[2]).cwd, `${home}/sub`, 'a subfolder cwd is not the project folder');
    assert.ok(await exists(path.join(path.dirname(result.jsonlPath), SESSION, 'note.txt')));
    assert.equal(await exists(jsonl), false);
    assert.equal(await exists(side), false);
    assert.equal(sessionsDb.getSessionById(SESSION)?.project_path, toCwd);
    assert.equal(sessionsDb.getSessionById(SESSION)?.jsonl_path, result.jsonlPath);
  });
});

test('a conversation Claude is still working in is not moved', async () => {
  await withHome(async (home) => {
    const { jsonl } = await seedConversation(home);
    const working: LiveSessionInfo = {
      jobId: 'abc12345', kind: 'background', alive: true, pid: process.pid, name: null,
      status: 'busy', state: 'working', detail: null, cwd: home, updatedAt: null,
    };
    liveSessionsService.setForTests(new Map([[SESSION, working]]));

    await assert.rejects(moveSessionToProject({ sessionId: SESSION, newProjectName: 'elsewhere' }), /still working/);
    assert.ok(await exists(jsonl), 'the original is untouched');
    assert.equal(sessionsDb.getSessionById(SESSION)?.project_path, home);
  });
});
