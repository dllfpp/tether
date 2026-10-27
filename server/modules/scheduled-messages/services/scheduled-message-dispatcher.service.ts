import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { liveSessionsService } from '@/modules/live-sessions/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { announceScheduledMessagesChanged } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;

// CloudCLI live: a queued turn whose delivery failed (a daemon job that did
// not wake up, a run that raced it) waits this long before the next try, and
// stays queued meanwhile — it is never dropped because one delivery failed.
const QUEUED_RETRY_DELAY_MS = 2 * 60 * 1000;
const queuedRetryAfter = new Map<string, number>();

/** @internal Forgets pending retry delays, so each test starts clean. */
export function resetQueuedRetriesForTests(): void {
  queuedRetryAfter.clear();
}

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  claimed: unknown,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(claimed);
  if (!message) {
    // An empty entry: dropped, and the next one goes on the next poll.
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  if (!result.started) {
    // Only a conversation that is gone makes the turn undeliverable for good.
    if (result.error === 'The session no longer exists.') {
      sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
      return;
    }
    // Anything else (a run that won the race, a daemon job that did not wake
    // up, a terminal holding the chat): put the turn back first in line.
    sessionDraftsDb.requeueFirstQueuedMessage(candidate, claimed);
    if (result.error !== 'A run was already in progress for this session.') {
      queuedRetryAfter.set(candidate.sessionId, Date.now() + QUEUED_RETRY_DELAY_MS);
      console.warn(`[ScheduledMessages] queued turn for ${candidate.sessionId} kept for a retry: ${result.error ?? 'not delivered'}`);
    }
    return;
  }
  queuedRetryAfter.delete(candidate.sessionId);
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId)
    || runtime.hasBackgroundWork(sessionId)
    || isDaemonJobWorking(sessionId);
}

/**
 * CloudCLI live: a Claude Code daemon job runs outside the chat run registry,
 * so the registry always calls it idle. Its own state says whether a turn is
 * in progress; the queued turn waits for it, as "when this finishes" promises.
 */
function isDaemonJobWorking(sessionId: string): boolean {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.provider !== 'claude') {
    return false;
  }
  const live = liveSessionsService.get(row.provider_session_id ?? row.session_id);
  if (!live || live.kind !== 'background' || !live.alive) {
    return false;
  }
  return live.state === 'working' || (!live.state && live.status === 'busy');
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if ((queuedRetryAfter.get(candidate.sessionId) ?? 0) > Date.now()) {
      return;
    }
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    // CloudCLI live: one queued message per turn, in queue order; the rest
    // wait for the next idle poll (the session is busy with this one).
    const taken = sessionDraftsDb.claimFirstQueuedMessage(candidate);
    if (!taken) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, taken.message, runtime);
  }));

  return claimed;
}

/** Records why a claimed message did not go, and shows it on its session's banner. */
function recordFailure(row: ScheduledMessageRow, reason: string): void {
  scheduledMessagesDb.markFailed(row.id, reason);
  announceScheduledMessagesChanged(row.session_id);
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      recordFailure(row, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(row, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
