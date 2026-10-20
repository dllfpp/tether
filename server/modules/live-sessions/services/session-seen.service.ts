import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LiveSessionInfo } from '@/shared/types.js';

/**
 * CloudCLI live: when a client last had each conversation open and on screen,
 * keyed by app session id. Reported by the chat over the websocket
 * (`chat.seen`); read by the job notifications, which skip a chat the user has
 * already looked at since its turn ended, and by the session lists, which mark
 * an unread reply. Kept in a file next to the database, so a restart does not
 * make every finished chat look unread.
 */
type SeenFile = {
  /** Turns that ended before Tether first kept this file count as read. */
  floor: number;
  seen: Record<string, number>;
};

let state: SeenFile | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let persist = true;

function seenFile(): string {
  const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
  return path.join(path.dirname(databasePath), 'session-seen.json');
}

function load(): SeenFile {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFile(), 'utf8')) as Partial<SeenFile>;
    state = {
      floor: typeof parsed.floor === 'number' ? parsed.floor : Date.now(),
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    };
  } catch {
    state = { floor: Date.now(), seen: {} };
    scheduleSave();
  }
  return state;
}

function scheduleSave(): void {
  if (!persist || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(seenFile(), JSON.stringify(state), 'utf8');
    } catch (error) {
      console.warn('[live-sessions] could not save session-seen.json:', error);
    }
  }, 2_000);
  saveTimer.unref();
}

/**
 * Used by the websocket module on `chat.seen`. Returns true when the
 * conversation had an unread reply, so the caller can tell the other clients.
 */
export function markSessionSeen(sessionId: string, at = Date.now(), live?: LiveSessionInfo | null): boolean {
  if (!sessionId) return false;
  const wasUnread = isSessionUnread(sessionId, live);
  const current = load();
  current.seen[sessionId] = Math.max(current.seen[sessionId] ?? 0, at);
  scheduleSave();
  return wasUnread;
}

/** Used by the job notifications: when the conversation was last on screen. */
export function sessionSeenAt(sessionId: string): number {
  const current = load();
  return Math.max(current.seen[sessionId] ?? 0, current.floor);
}

/**
 * Used by the session lists (sidebar fetch and upserts): a background job that
 * ended its turn (done, or waiting for the user) after it was last on screen.
 */
export function isSessionUnread(sessionId: string, live: LiveSessionInfo | null | undefined): boolean {
  if (!live || live.kind !== 'background' || !live.alive || !live.updatedAt) return false;
  const jobState = (live.state ?? '').toLowerCase();
  const ended = jobState === 'done' || jobState === 'blocked' || jobState.includes('input');
  if (!ended) return false;
  const endedAt = Date.parse(live.updatedAt);
  return Number.isFinite(endedAt) && endedAt > sessionSeenAt(sessionId);
}

/** @internal */
export function resetSessionSeenForTests(): void {
  persist = false;
  state = { floor: 0, seen: {} };
}
