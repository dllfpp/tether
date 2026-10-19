import fs from 'node:fs/promises';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

/**
 * Predicts the user's next prompt for a conversation, like the grey
 * suggestion Claude Code shows in its prompt line after each turn.
 *
 * Claude Code keeps that suggestion only inside its terminal UI (a background
 * job never writes it anywhere readable), so the app asks a small model
 * itself, with the same rules. The call is isolated: nothing is saved to
 * ~/.claude/projects (no extra conversation in any list), no settings,
 * plugins or hooks are loaded, and no tools are available. One call per turn
 * at most: results are cached by the conversation's last message.
 */

// Enough to reach back to the user's message even after a turn full of tool output.
const TAIL_BYTES = 8 * 1024 * 1024;
// Context is built by turns, not by message count: one long turn of the
// assistant can hold dozens of progress messages, which would otherwise push
// the user's own words out of the window. Claude Code sees the whole
// conversation; these budgets keep the parts that decide the next prompt.
const PREVIOUS_MESSAGES = 6;
const PREVIOUS_MESSAGE_CHARS = 1_500;
const USER_MESSAGE_CHARS = 4_000;
const PROGRESS_MESSAGES = 8;
const PROGRESS_MESSAGE_CHARS = 300;
const FINAL_REPLY_CHARS = 10_000;
const MAX_SUGGESTION_CHARS = 120;
const CACHE_LIMIT = 200;

const SUGGESTION_RULES = `You predict the next message the USER will type in a coding-assistant chat.
Predict what they themselves would write next, not what you think they ought to do.
The bar: they would think "that is exactly what I was about to type".

Typical cases:
- the user asked for a change plus a follow-up step and the change is done -> that follow-up step
- code was just written -> asking to try or run it
- the assistant offered options -> the option this user would most likely pick
- the assistant asked whether to continue -> a short go-ahead in the user's words
- task finished with an obvious next step -> that step (for example commit or deploy)
- the assistant left something for the user to do or decide -> the user asking the assistant to do it
- an error or a misunderstanding just happened -> a short instruction to fix or retry it

ALWAYS answer with your single best guess, even when the next step is not certain: the most likely
follow-up given what the user has been asking for. The only exception: reply with nothing when any
suggestion would touch a sensitive topic (credentials, security incidents, private data, anything
potentially harmful).

Never produce: praise or thanks, sentences in the assistant's voice, more than one sentence.

The suggestion is always something the user sends TO the assistant: an instruction or a short answer
(like "run the tests", "yes, go ahead", "deploy it"). It is never a report of what the user did or saw,
and never an opinion about the result.

Write 2 to 12 words in the same language the user writes in, matching their style. Reply with only the
suggestion text, with no quotes and no explanation.`;

type ChatLine = { role: 'user' | 'assistant'; text: string; uuid: string | null; model: string | null };

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

type RecentConversation = {
  /** Real conversation messages, newest last; tool traffic and harness notes are skipped. */
  chat: ChatLine[];
  /**
   * The assistant's latest message closed its turn (stop_reason end_turn).
   * Read from the transcript rather than from the job's busy status, which
   * stays busy while the job has background tasks open after its reply.
   */
  turnEnded: boolean;
};

const TURN_END_REASONS = new Set(['end_turn', 'stop_sequence']);

async function readRecentConversation(transcriptPath: string): Promise<RecentConversation> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(transcriptPath, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) {
      lines.shift(); // partial first line
    }

    const chat: ChatLine[] = [];
    let lastStopReason: string | null = null;
    for (const line of lines) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.isMeta || event.isSidechain || event.isCompactSummary) {
        continue;
      }
      const message = event.message as { role?: string; content?: unknown; model?: unknown; stop_reason?: unknown } | undefined;
      if (event.type === 'assistant') {
        // Every assistant entry counts here, tool calls included: only the
        // last one says whether the turn is over.
        lastStopReason = typeof message?.stop_reason === 'string' ? message.stop_reason : null;
      }
      const text = textOf(message?.content).trim();
      // Command echoes, reminders and task notifications are machinery, not the user typing.
      if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) {
        continue;
      }
      const role = event.type === 'user' ? 'user' : 'assistant';
      if (role === 'user') {
        // The user spoke after the last reply: a new turn has started.
        lastStopReason = null;
      }
      chat.push({
        role,
        text,
        uuid: typeof event.uuid === 'string' ? event.uuid : null,
        model: typeof message?.model === 'string' ? message.model : null,
      });
    }
    return { chat, turnEnded: lastStopReason !== null && TURN_END_REASONS.has(lastStopReason) };
  } catch {
    return { chat: [], turnEnded: false };
  } finally {
    await handle?.close();
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * @internal The latest turn in full (the user's message, the assistant's
 * progress notes shortened, its final reply), preceded by a few earlier
 * messages. Null when the conversation holds no user message at all.
 * Exported only for the module's tests.
 */
export function buildContext(chat: ChatLine[]): string | null {
  let lastUser = -1;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (chat[index].role === 'user') {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) {
    return null;
  }

  const earlier = chat
    .slice(Math.max(0, lastUser - PREVIOUS_MESSAGES), lastUser)
    .map((line) => `${line.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(line.text, PREVIOUS_MESSAGE_CHARS)}`);

  const replies = chat.slice(lastUser + 1);
  const finalReply = replies.at(-1);
  const progress = replies.slice(0, -1).slice(-PROGRESS_MESSAGES);
  const turn = [
    `USER: ${clip(chat[lastUser].text, USER_MESSAGE_CHARS)}`,
    ...(progress.length > 0
      ? [`ASSISTANT (progress notes during the turn):\n${progress.map((line) => `- ${clip(line.text, PROGRESS_MESSAGE_CHARS)}`).join('\n')}`]
      : []),
    ...(finalReply ? [`ASSISTANT (final reply):\n${clip(finalReply.text, FINAL_REPLY_CHARS)}`] : []),
  ];

  return [...(earlier.length > 0 ? ['[Earlier]', ...earlier, '[Latest turn]'] : []), ...turn].join('\n\n');
}

/** Keeps only what Claude Code would show: one short line in the user's voice. */
export function cleanSuggestion(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0]?.trim() ?? '';
  const unquoted = firstLine.replace(/^["'“”«»`]+|["'“”«»`]+$/g, '').trim();
  if (!unquoted || unquoted.length > MAX_SUGGESTION_CHARS) {
    return null;
  }
  const words = unquoted.split(/\s+/).length;
  if (words > 18 || /^(i'll|let me|here's|sure|ok,? i)/i.test(unquoted)) {
    return null;
  }
  return unquoted;
}

type Generator = (context: string, model: string) => Promise<string>;

// Model ids as Claude Code writes them in transcripts; anything else falls back.
const SAFE_MODEL = /^[A-Za-z0-9._:[\]-]{1,80}$/;

/**
 * The model that answers the conversation, like Claude Code, which asks the
 * session's own model. LIVE_SUGGESTION_MODEL forces one (e.g. "haiku" to
 * spend less).
 */
function suggestionModel(chat: ChatLine[]): string {
  const forced = process.env.LIVE_SUGGESTION_MODEL;
  if (forced) {
    return forced;
  }
  const sessionModel = [...chat].reverse().find((line) => line.role === 'assistant' && line.model)?.model;
  return sessionModel && SAFE_MODEL.test(sessionModel) && sessionModel !== '<synthetic>' ? sessionModel : 'haiku';
}

async function generateWithClaude(context: string, model: string): Promise<string> {
  let result = '';
  const run = query({
    prompt: `Conversation so far (latest last):\n\n${context}\n\nThe user's next message:`,
    options: {
      model,
      systemPrompt: SUGGESTION_RULES,
      tools: [],
      // Two turns: a run that tries an extra step would otherwise end in an error.
      maxTurns: 2,
      persistSession: false,
      settingSources: [],
      cwd: os.tmpdir(),
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
    },
  });
  for await (const message of run) {
    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }
  return result;
}

let generator: Generator = generateWithClaude;

/** @internal The module's tests replace the model call. */
export function setSuggestionGeneratorForTests(fake: Generator | null): void {
  generator = fake ?? generateWithClaude;
  cache.clear();
  inFlight.clear();
}

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Used by the live-sessions routes: the suggested next prompt for a
 * conversation, or null. Null while a turn is still open (last message from
 * the user) and whenever the model has nothing obvious to suggest.
 */
export async function suggestNextPrompt(transcriptPath: string | null | undefined): Promise<string | null> {
  if (!transcriptPath || process.env.LIVE_PROMPT_SUGGESTIONS === '0') {
    return null;
  }
  const { chat, turnEnded } = await readRecentConversation(transcriptPath);
  const last = chat.at(-1);
  const context = buildContext(chat);
  if (!turnEnded || !last || last.role !== 'assistant' || !context) {
    return null;
  }

  const key = `${transcriptPath}#${last.uuid ?? last.text.length}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  const running = inFlight.get(key);
  if (running) {
    return running;
  }

  const task = (async () => {
    try {
      const model = suggestionModel(chat);
      // A suggestion is wanted after every turn; an empty or unusable answer
      // is asked again, up to three times.
      let suggestion: string | null = null;
      for (let attempt = 0; attempt < 3 && !suggestion; attempt += 1) {
        try {
          suggestion = cleanSuggestion(await generator(context, model));
        } catch (error) {
          // One failed call (for example a run that ended on its turn limit)
          // must not cost the whole suggestion.
          console.warn('[live-sessions] prompt suggestion attempt failed:', error instanceof Error ? error.message : error);
        }
      }
      if (cache.size >= CACHE_LIMIT) {
        cache.delete(cache.keys().next().value as string);
      }
      cache.set(key, suggestion);
      return suggestion;
    } catch (error) {
      console.warn('[live-sessions] prompt suggestion failed:', error instanceof Error ? error.message : error);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

// Conversations someone looked at recently, by provider id: only these get a
// suggestion prepared as soon as their job finishes a turn.
const WATCH_MS = 30 * 60 * 1000;
const watched = new Map<string, number>();

/**
 * Used by the live-sessions routes. Never waits for the model (a cold call
 * can take tens of seconds, longer than a proxy keeps a request open):
 * returns what is ready and starts the generation in the background, and
 * the client asks again while `pending` is true.
 */
export async function peekSuggestionForSession(sessionId: string): Promise<{ suggestion: string | null; pending: boolean }> {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.provider !== 'claude' || !row.jsonl_path) {
    return { suggestion: null, pending: false };
  }
  const providerSessionId = row.provider_session_id ?? row.session_id;
  watched.set(providerSessionId, Date.now());
  // Until the assistant's reply has closed its turn there is nothing to
  // suggest yet: tell the client to keep asking.
  const { turnEnded } = await readRecentConversation(row.jsonl_path);
  if (!turnEnded) {
    return { suggestion: null, pending: true };
  }

  const generation = suggestNextPrompt(row.jsonl_path);
  const ready = await Promise.race([generation, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50))]);
  return ready === 'pending' ? { suggestion: null, pending: true } : { suggestion: ready, pending: false };
}

/**
 * Used by server startup on live-state changes: prepares the suggestion for
 * watched conversations, so it is ready when the user looks at the chat
 * (nothing is generated until the transcript shows the turn has ended).
 */
export function prefetchSuggestions(providerSessionIds: string[]): void {
  const now = Date.now();
  for (const providerSessionId of providerSessionIds) {
    const seenAt = watched.get(providerSessionId);
    if (seenAt === undefined) {
      continue;
    }
    if (now - seenAt > WATCH_MS) {
      watched.delete(providerSessionId);
      continue;
    }
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (row?.jsonl_path) {
      void suggestNextPrompt(row.jsonl_path);
    }
  }
}
