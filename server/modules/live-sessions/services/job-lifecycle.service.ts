import { execFile } from 'node:child_process';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveLiveRoute } from '@/modules/live-sessions/services/live-routing.service.js';
import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Keeps deletions the same on both sides: a job deleted in Claude Code is
 * archived in the app (its transcript stays on disk, as Claude Code leaves
 * it), and a job deleted in the app is removed from Claude Code too.
 */

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Used by server startup when Claude Code reports deleted jobs: archives the
 * matching app sessions and returns their app ids, for the removal broadcast.
 * New activity in the transcript un-archives a session again (synchronizer).
 */
export function archiveDeletedJobSessions(providerSessionIds: string[]): string[] {
  const archived: string[] = [];
  for (const providerSessionId of providerSessionIds) {
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (row && !row.isArchived) {
      sessionsDb.updateSessionIsArchived(row.session_id, true);
      archived.push(row.session_id);
    }
  }
  return archived;
}

function runCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.env.CLAUDE_CLI_PATH || 'claude',
      args,
      { cwd: process.env.HOME || '/', timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, output: `${String(stdout)}\n${String(stderr)}`.trim() });
      },
    );
  });
}

/**
 * Used by the providers module before it archives or deletes a session: when
 * the conversation belongs to a daemon job, the job is deleted in Claude Code
 * (`claude rm`, which also removes its worktree when that is safe). One open
 * in a terminal is refused, since nothing outside that terminal may close it.
 */
export async function removeClaudeJobForSession(row: {
  provider?: string | null;
  session_id?: string | null;
  provider_session_id?: string | null;
}): Promise<void> {
  if ((row.provider ?? 'claude') !== 'claude') {
    return;
  }
  const route = resolveLiveRoute(row);
  if (route.mode === 'interactive') {
    throw new AppError('This conversation is open in a terminal. Close it there first.', {
      code: 'LIVE_DELETE_IN_TERMINAL',
      statusCode: 409,
    });
  }
  if (route.mode !== 'job' || !SAFE_JOB_ID.test(route.jobId)) {
    return;
  }
  const result = await runCli(['rm', route.jobId]);
  void liveSessionsService.refresh();
  if (result.code !== 0 && !/not found|no such/i.test(result.output)) {
    throw new AppError(result.output || 'claude rm failed.', { code: 'LIVE_DELETE_FAILED', statusCode: 422 });
  }
}
