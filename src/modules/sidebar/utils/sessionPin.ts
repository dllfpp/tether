import { api } from '@/shared/api';

/**
 * CloudCLI live: pins a conversation to the top of its project's list, or
 * unpins it. The server tells every client with a session upsert, which is
 * what moves the row, so there is no local state to update here.
 */
export async function setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
  const response = await api.setSessionPinned(sessionId, pinned);
  if (!response.ok) {
    throw new Error(`Could not ${pinned ? 'pin' : 'unpin'} the conversation (${response.status}).`);
  }
}
