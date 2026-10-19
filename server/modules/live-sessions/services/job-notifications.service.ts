import { open } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { claudeHome, liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { sessionSeenAt } from '@/modules/live-sessions/services/session-seen.service.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';

type JobOutcome = 'done' | 'input' | 'failed';

/** One line of `~/.claude/jobs/<id>/timeline.jsonl`. */
type TimelineEntry = { at?: string; state?: string; detail?: string; text?: string };

function outcomeOf(state: string | null | undefined): JobOutcome | null {
  if (state === 'done') return 'done';
  if (state === 'blocked' || state === 'needs_input' || state === 'needs-input') return 'input';
  if (state === 'failed' || state === 'error') return 'failed';
  return null;
}

/** The job's latest timeline entry, read from the end of the file. */
async function lastTimelineEntry(jobId: string): Promise<TimelineEntry | null> {
  let handle;
  try {
    handle = await open(path.join(claudeHome(), 'jobs', jobId, 'timeline.jsonl'), 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1] ?? '') as TimelineEntry;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * A turn that ended and now waits for the user. The timeline marks it with the
 * reply's text; a message from the user is an entry with empty text, whatever
 * the state (a job waiting for input stays `blocked` while it reads it).
 */
function endedTurn(entry: TimelineEntry | null): (TimelineEntry & { at: string }) | null {
  if (!entry?.at || !entry.text || !outcomeOf(entry.state)) return null;
  return entry as TimelineEntry & { at: string };
}

/**
 * CloudCLI live: the provider runtimes notify only for turns this app runs
 * itself. Daemon jobs run outside it, so they are read from the live job list
 * and the job's timeline: when a turn ends (done, waiting for the user, or
 * failed) and nothing else happens for PENDING_BEFORE_NOTIFY_MS, one
 * notification goes through the user's enabled channels (web push on the
 * phone, desktop, in-app), titled with the chat's name and carrying the job's
 * summary line. A reply, or the job starting again, in the meantime cancels it.
 */
const PENDING_BEFORE_NOTIFY_MS = 5 * 60_000;

type JobNotificationDeps = {
  readLastEntry: (jobId: string) => Promise<TimelineEntry | null>;
  notify: typeof notifyJobOutcome;
  delayMs: number;
  recheckMs?: number;
  /** When the conversation (by provider session id) was last on screen in a client. */
  seenAt: (providerSessionId: string) => number;
};

export function startJobNotifications(
  deps: JobNotificationDeps = {
    readLastEntry: lastTimelineEntry,
    notify: notifyJobOutcome,
    delayMs: PENDING_BEFORE_NOTIFY_MS,
    seenAt: (providerSessionId) => {
      const session = sessionsDb.getSessionByProviderSessionId(providerSessionId);
      return session ? sessionSeenAt(session.session_id) : 0;
    },
  },
): () => void {
  const pending = new Map<string, { at: string; timer: NodeJS.Timeout }>();
  const seen = new Map<string, string | null>();
  const rechecking = new Set<string>();

  const cancel = (providerSessionId: string) => {
    const entry = pending.get(providerSessionId);
    if (entry) clearTimeout(entry.timer);
    pending.delete(providerSessionId);
  };

  const check = async (providerSessionId: string) => {
    const info = liveSessionsService.get(providerSessionId);
    if (!info || info.kind !== 'background' || !info.jobId) {
      cancel(providerSessionId);
      return;
    }
    const ended = endedTurn(await deps.readLastEntry(info.jobId));
    // The first read of a job (the list is read in full right after start)
    // only records where it stands: a turn that ended before this server
    // started does not notify.
    const firstSight = !seen.has(providerSessionId);
    seen.set(providerSessionId, ended?.at ?? null);
    if (!ended) {
      cancel(providerSessionId); // working again, or the user replied
      // The job list can change before the turn's entry reaches the
      // timeline; look again once it has been written.
      if (!firstSight && !rechecking.has(providerSessionId)) {
        rechecking.add(providerSessionId);
        setTimeout(() => {
          rechecking.delete(providerSessionId);
          void check(providerSessionId).catch(() => undefined);
        }, deps.recheckMs ?? 4_000);
      }
      return;
    }
    if (pending.get(providerSessionId)?.at === ended.at) return;
    // Seen first right after a restart: a turn that ended less than the wait
    // ago still counts, for the time that is left (a restart drops timers).
    const elapsed = Date.now() - Date.parse(ended.at);
    if (firstSight && !(elapsed >= 0 && elapsed < deps.delayMs)) return;
    const waitMs = firstSight ? deps.delayMs - elapsed : deps.delayMs;
    cancel(providerSessionId);

    const jobId = info.jobId;
    const timer = setTimeout(async () => {
      pending.delete(providerSessionId);
      const still = endedTurn(await deps.readLastEntry(jobId));
      const outcome = outcomeOf(still?.state);
      // Looked at since the turn ended (open and on screen in a client):
      // the user already knows, so no notification.
      const seen = deps.seenAt(providerSessionId) >= Date.parse(ended.at);
      console.log(`[job-notifications] ${jobId} wait over: ${seen ? 'seen' : still?.at === ended.at && outcome ? 'notify' : 'skip'}`);
      if (!seen && still?.at === ended.at && outcome) {
        deps.notify(providerSessionId, still.detail || info.detail, info.name, outcome);
      }
    }, waitMs);
    pending.set(providerSessionId, { at: ended.at, timer });
  };

  const stop = liveSessionsService.onChange((changed) => {
    for (const providerSessionId of changed) {
      void check(providerSessionId).catch((error) => {
        console.warn('[job-notifications] check failed:', error);
      });
    }
  });

  return () => {
    stop();
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}

function notifyJobOutcome(
  providerSessionId: string,
  detail: string | null | undefined,
  name: string | null,
  outcome: JobOutcome,
): void {
  const session = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  const user = userDb.getFirstUser();
  if (!session || !user) return;

  const fallback = outcome === 'done' ? 'Finished' : outcome === 'input' ? 'Waiting for your reply' : 'Failed';
  // The orchestrator is plain JS: its `= null` defaults type sessionId and
  // dedupeKey as null-only, though it takes strings for both.
  type EventInput = Parameters<typeof createNotificationEvent>[0];
  notifyUserIfEnabled({
    userId: user.id,
    event: createNotificationEvent(<EventInput><unknown>{
      provider: 'claude',
      sessionId: session.session_id,
      kind: outcome === 'input' ? 'action_required' : outcome === 'failed' ? 'error' : 'stop',
      code: 'agent.notification',
      meta: { message: detail || fallback, sessionName: name },
      severity: outcome === 'failed' ? 'error' : 'info',
      requiresUserAction: outcome === 'input',
    }),
  });
}
