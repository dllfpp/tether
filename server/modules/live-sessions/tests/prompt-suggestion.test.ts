import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { liveSessionsService } from '@/modules/live-sessions/index.js';
import {
  cleanSuggestion,
  peekSuggestionForSession,
  setSuggestionGeneratorForTests,
  suggestNextPrompt,
} from '@/modules/live-sessions/services/prompt-suggestion.service.js';
import type { LiveSessionInfo } from '@/shared/types.js';

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const user = (text: string, uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: text } });
// A reply that closes the turn, and a progress note followed by a tool call.
const assistant = (text: string, uuid: string) => line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const progress = (text: string, uuid: string) => line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text }] } });

test('suggestions are cleaned to one short line in the user voice', () => {
  assert.equal(cleanSuggestion('"run the tests"\n'), 'run the tests');
  assert.equal(cleanSuggestion('«fai il deploy»'), 'fai il deploy');
  assert.equal(cleanSuggestion('pubblichi anche la release?'), 'pubblichi anche la release?');
  assert.equal(cleanSuggestion("I'll run the tests now"), null);
  assert.equal(cleanSuggestion(''), null);
  assert.equal(cleanSuggestion('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'), null);
});

test('one model call per turn, nothing while the user spoke last', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suggest-'));
  const contexts: string[] = [];
  setSuggestionGeneratorForTests(async (context) => {
    contexts.push(context);
    return '"fai il deploy"';
  });
  try {
    const transcript = path.join(dir, 's.jsonl');
    await writeFile(transcript, user('sistema il grafico e poi fai il deploy', 'u1'));
    assert.equal(await suggestNextPrompt(transcript), null, 'turn still open');

    await appendFile(transcript, line({ type: 'user', isMeta: true, message: { content: '<system-reminder>x</system-reminder>' } }));
    await appendFile(transcript, assistant('Grafico sistemato.', 'a1'));
    assert.equal(await suggestNextPrompt(transcript), 'fai il deploy');
    assert.equal(await suggestNextPrompt(transcript), 'fai il deploy');
    assert.equal(contexts.length, 1, 'cached for the same turn');
    assert.match(contexts[0], /USER: sistema il grafico/);
    assert.doesNotMatch(contexts[0], /system-reminder/);

    await appendFile(transcript, user('fatto?', 'u2'));
    await appendFile(transcript, assistant('Sì, pubblicato.', 'a2'));
    await suggestNextPrompt(transcript);
    assert.equal(contexts.length, 2, 'a new turn asks again');

    process.env.LIVE_PROMPT_SUGGESTIONS = '0';
    assert.equal(await suggestNextPrompt(transcript), null);
  } finally {
    delete process.env.LIVE_PROMPT_SUGGESTIONS;
    setSuggestionGeneratorForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a long turn full of progress notes still gets a suggestion built around the user message', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suggest-long-'));
  const contexts: string[] = [];
  setSuggestionGeneratorForTests(async (context) => {
    contexts.push(context);
    return 'crea anche la release';
  });
  try {
    const transcript = path.join(dir, 'long.jsonl');
    let body = user('vecchia richiesta', 'u0') + assistant('Fatto prima.', 'a0') + user('crea il tag v1.38.2', 'u1');
    for (let index = 0; index < 30; index += 1) {
      body += progress(`Passo intermedio numero ${index}.`, `p${index}`);
    }
    body += assistant('Ho creato il tag v1.38.2 e fatto il deploy.', 'final');
    await writeFile(transcript, body);

    assert.equal(await suggestNextPrompt(transcript), 'crea anche la release');
    assert.match(contexts[0], /USER: crea il tag v1\.38\.2/);
    assert.match(contexts[0], /final reply\):\nHo creato il tag v1\.38\.2/);
    assert.match(contexts[0], /Passo intermedio numero 28/);
    assert.doesNotMatch(contexts[0], /Passo intermedio numero 3\./, 'only the last progress notes');
  } finally {
    setSuggestionGeneratorForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('empty answers are asked again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suggest-retry-'));
  const answers: Array<string | Error> = [new Error('Reached maximum number of turns (1)'), '', 'lancia i test'];
  let calls = 0;
  setSuggestionGeneratorForTests(async () => {
    const answer = answers[calls++] ?? '';
    if (answer instanceof Error) throw answer;
    return answer;
  });
  try {
    const transcript = path.join(dir, 'retry.jsonl');
    await writeFile(transcript, user('scrivi i test', 'u1') + assistant('Scritti.', 'a1'));
    assert.equal(await suggestNextPrompt(transcript), 'lancia i test');
    assert.equal(calls, 3);
  } finally {
    setSuggestionGeneratorForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('the suggestion comes from the session model, like Claude Code, unless one is forced', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'suggest-model-'));
  const models: string[] = [];
  setSuggestionGeneratorForTests(async (_context, model) => {
    models.push(model);
    return 'sposta il tag';
  });
  try {
    const transcript = path.join(dir, 'm.jsonl');
    await writeFile(transcript, user('crea il tag', 'u1') + line({
      type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tag creato.' }] },
    }));
    await suggestNextPrompt(transcript);
    assert.deepEqual(models, ['claude-opus-5-5']);

    process.env.LIVE_SUGGESTION_MODEL = 'haiku';
    await appendFile(transcript, user('ok', 'u2') + assistant('Fatto.', 'a2'));
    await suggestNextPrompt(transcript);
    assert.deepEqual(models, ['claude-opus-5-5', 'haiku']);
  } finally {
    delete process.env.LIVE_SUGGESTION_MODEL;
    setSuggestionGeneratorForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('the route answers at once: pending first, ready later; the transcript decides, not the busy flag', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'suggest-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  let release: (value: string) => void = () => undefined;
  setSuggestionGeneratorForTests(() => new Promise<string>((resolve) => { release = resolve; }));
  try {
    const transcript = path.join(dir, 'chat.jsonl');
    await writeFile(transcript, user('scrivi i test', 'u1') + assistant('Test scritti.', 'a1'));
    sessionsDb.createSession('chat-1', 'claude', dir, 'Chat', undefined, undefined, transcript);

    assert.deepEqual(await peekSuggestionForSession('chat-1'), { suggestion: null, pending: true });
    release('lancia i test');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await peekSuggestionForSession('chat-1'), { suggestion: 'lancia i test', pending: false });

    const busy: LiveSessionInfo = {
      jobId: 'chat0001', kind: 'background', alive: true, pid: 1, name: null, status: 'busy',
      state: 'working', detail: null, cwd: dir, updatedAt: null,
    };
    // A job with background tasks open stays busy after its reply: the turn is over all the same.
    liveSessionsService.setForTests(new Map([['chat-1', busy]]));
    assert.deepEqual(await peekSuggestionForSession('chat-1'), { suggestion: 'lancia i test', pending: false });

    // A new turn still running (last entry is a tool call): keep asking.
    await appendFile(transcript, user('e ora il deploy', 'u2') + progress('Faccio il deploy.', 'p1'));
    assert.deepEqual(await peekSuggestionForSession('chat-1'), { suggestion: null, pending: true });
  } finally {
    setSuggestionGeneratorForTests(null);
    liveSessionsService.setForTests(new Map());
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
