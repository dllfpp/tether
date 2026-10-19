import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import type { LiveSessionInfo } from '@/shared/types.js';

/**
 * Decides where a turn for one app session must go.
 *
 * - `job`: the conversation belongs to a daemon background job (running or
 *   stopped). Turns are delivered into that job, never through a new process.
 * - `interactive`: a terminal session holds the conversation right now. Nothing
 *   can join it from outside, and resuming it elsewhere would split it.
 * - `none`: no process owns it; the app's own runtime may resume it.
 */
export type LiveRoute =
  | { mode: 'job'; jobId: string; info: LiveSessionInfo }
  | { mode: 'interactive'; info: LiveSessionInfo }
  | { mode: 'none' };

type SessionRowLike = {
  provider?: string | null;
  session_id?: string | null;
  provider_session_id?: string | null;
};

/**
 * Used by the websocket module before any chat turn (send, edit, scheduled)
 * and by this module's stop service.
 */
export function resolveLiveRoute(row: SessionRowLike | null | undefined): LiveRoute {
  if (!row || (row.provider ?? 'claude') !== 'claude') {
    return { mode: 'none' };
  }

  const info = liveSessionsService.get(row.provider_session_id ?? row.session_id ?? null);
  if (!info) {
    return { mode: 'none' };
  }

  if (info.kind === 'background' && info.jobId) {
    return { mode: 'job', jobId: info.jobId, info };
  }

  if (info.alive) {
    return { mode: 'interactive', info };
  }

  return { mode: 'none' };
}
