/**
 * CloudCLI live: when a client last had each conversation open and on screen,
 * keyed by app session id. Reported by the chat over the websocket
 * (`chat.seen`); read by the job notifications, which skip a chat the user has
 * already looked at since its turn ended. In memory: after a restart nothing
 * counts as seen, so a notification may go out rather than be lost.
 */
const lastSeen = new Map<string, number>();

export function markSessionSeen(sessionId: string, at = Date.now()): void {
  if (!sessionId) return;
  lastSeen.set(sessionId, Math.max(lastSeen.get(sessionId) ?? 0, at));
}

export function sessionSeenAt(sessionId: string): number {
  return lastSeen.get(sessionId) ?? 0;
}

/** @internal */
export function resetSessionSeenForTests(): void {
  lastSeen.clear();
}
