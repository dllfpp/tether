import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isLiveForkInstall } from '@/modules/live-sessions/index.js';

import { createSystemUpdateService } from '../system.service.js';

test('a CloudCLI live install never runs the built-in update', async () => {
  const appRoot = await mkdtemp(path.join(tmpdir(), 'cloudcli-live-root-'));
  try {
    await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ version: '1.38.1', cloudcliLive: { upstreamVersion: '1.37.3' } }));
    assert.equal(isLiveForkInstall(appRoot), true);

    const commands: string[] = [];
    const service = createSystemUpdateService({
      appRoot,
      homeDirectory: '/home/cloudcli',
      installMode: 'npm',
      isPlatform: false,
      environment: {},
      runShellCommand: async (command) => {
        commands.push(command);
        return { exitCode: 0, output: 'updated', errorOutput: '' };
      },
      logInfo: () => undefined,
      logError: () => undefined,
    });

    const result = await service.updateSystem();
    assert.equal(result.success, false);
    assert.match(String((result as { error?: string }).error), /CloudCLI live/);
    assert.deepEqual(commands, []);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test('an unmodified install is not taken for the fork', async () => {
  const appRoot = await mkdtemp(path.join(tmpdir(), 'cloudcli-root-'));
  try {
    await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ version: '1.37.3' }));
    assert.equal(isLiveForkInstall(appRoot), false);
    assert.equal(isLiveForkInstall(path.join(appRoot, 'missing')), false);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
