import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

const POLL_MS = 5_000;
// Up to five minutes: long enough for a job to finish its turn and the model to answer.
const MAX_POLLS = 60;

type UsePromptSuggestionArgs = {
  /** App session id of the open chat, or null for none / non-Claude chats. */
  sessionId: string | null;
  /** False while a turn is running: a suggestion only makes sense between turns. */
  enabled: boolean;
  /** Changes whenever the conversation changed on disk, so a new turn gets a new suggestion. */
  refreshKey?: number;
};

/**
 * Used by the chat module's composer: the suggested next prompt for the open
 * conversation, like the grey text in Claude Code's prompt line. The server
 * may still be generating it, so the hook asks again until it is ready.
 */
export function usePromptSuggestion({ sessionId, enabled, refreshKey }: UsePromptSuggestionArgs) {
  // The suggestion to show while the input is empty; null when there is none.
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    setSuggestion(null);
    if (!sessionId || !enabled) {
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    const ask = async () => {
      try {
        const response = await api.livePromptSuggestion(sessionId);
        if (!response.ok || cancelled) {
          return;
        }
        const body = await response.json() as { data?: { suggestion?: string | null; pending?: boolean } };
        if (cancelled) {
          return;
        }
        if (typeof body.data?.suggestion === 'string' && body.data.suggestion.trim()) {
          setSuggestion(body.data.suggestion);
        } else if (body.data?.pending && polls < MAX_POLLS) {
          polls += 1;
          timer = setTimeout(() => void ask(), POLL_MS);
        }
      } catch {
        // No suggestion is fine; the composer simply shows its usual placeholder.
      }
    };
    void ask();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [sessionId, enabled, refreshKey]);

  const dismiss = useCallback(() => setSuggestion(null), []);

  return { suggestion, dismiss };
}
