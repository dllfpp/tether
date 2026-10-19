import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { resolveLiveRoute } from '@/modules/live-sessions/services/live-routing.service.js';
import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Delivers user turns to Claude Code background jobs, and starts and stops
 * them, without ever opening a second process on a job's conversation.
 *
 * Delivery drives the CLI's own public entry point: `claude attach <jobId>` in
 * a pseudo terminal, the text as a bracketed paste (so newlines stay inside
 * one message), Enter, then detach. Attaching to a stopped job restarts it
 * under the same id, so one path covers live and finished jobs. Delivery is
 * confirmed by the job's transcript growing.
 */

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{4,64}$/;
const RENDER_SETTLE_MS = 1_200;
// A job the daemon retired (idle or low memory) is woken by attach, which can
// take long on a loaded machine; the CLI itself waits without limit.
const RENDER_MAX_WAIT_MS = 90_000;
const CONFIRM_MAX_WAIT_MS = 60_000;
const BUSY_PROMPT_SETTLE_MS = 1_500;
const ATTACH_ATTEMPTS = 2;
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z]/g;

type SpawnPty = typeof pty.spawn;

let spawnPtyImpl: SpawnPty = pty.spawn;

/** @internal The module's tests swap the PTY for a fake. */
export function setSpawnPtyForTests(spawn: SpawnPty | null): void {
  spawnPtyImpl = spawn ?? pty.spawn;
}

function cliPath(): string {
  return process.env.CLAUDE_CLI_PATH || 'claude';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileSize(filePath: string | null | undefined): Promise<number | null> {
  if (!filePath) {
    return null;
  }
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return null;
  }
}

/** One delivery per job at a time: two attaches on one job would interleave keystrokes. */
const jobQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(jobId: string, task: () => Promise<T>): Promise<T> {
  const previous = jobQueues.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  jobQueues.set(jobId, next);
  void next.finally(() => {
    if (jobQueues.get(jobId) === next) {
      jobQueues.delete(jobId);
    }
  });
  return next;
}

/**
 * @internal Strips what would end the bracketed paste early or act as a key
 * press; exported only for the module's tests.
 */
export function sanitizeForPaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/**
 * The attach view is ready once its prompt bar is drawn and output has gone
 * quiet. Quiet alone is not enough: a waking job prints "Waking session…" and
 * then stays silent while it reloads, and a paste sent then is lost.
 */
async function waitForAttachReady(
  getLastOutputAt: () => number,
  getScreen: () => string,
  isExited: () => boolean,
  startedAt: number,
  term?: IPty,
): Promise<boolean> {
  let trustAnswered = false;
  let busyPromptSince = 0;
  while (Date.now() - startedAt < RENDER_MAX_WAIT_MS && !isExited()) {
    await sleep(200);
    // CloudCLI live: a job mid-turn never goes quiet (its spinner keeps
    // drawing), but its input is there under "esc to interrupt" and Claude
    // Code queues what is typed into it. Ready once that has held a moment.
    if (isBusyPromptDrawn(getScreen())) {
      busyPromptSince ||= Date.now();
      if (Date.now() - busyPromptSince >= BUSY_PROMPT_SETTLE_MS) {
        return true;
      }
    } else {
      busyPromptSince = 0;
    }
    // Waking a job in the home folder asks the folder question when no other
    // session holds the home's trust: answer "Yes" for this session only.
    if (term && !trustAnswered && compactScreen(getScreen()).includes('Yes,Itrustthisfolder')) {
      trustAnswered = await answerFolderTrust(term, getScreen, getLastOutputAt);
      continue;
    }
    const last = getLastOutputAt();
    if (last > 0 && Date.now() - last >= RENDER_SETTLE_MS && isPromptDrawn(getScreen())) {
      return true;
    }
  }
  return false;
}

/**
 * @internal The attach view's status bar ("← for agents" / "shift+tab to
 * cycle"), drawn after the last "Waking"/"Attaching" notice. Not "❯": the
 * replayed history shows every past user message with it, long before the
 * input is ready.
 */
export function isBusyPromptDrawn(screen: string): boolean {
  const compact = screen.replace(/\x1b\[[0-9;?<>]*[A-Za-z~]/g, '').replace(/\s+/g, '');
  const start = Math.max(compact.lastIndexOf('Wakingsession'), compact.lastIndexOf('Attaching'), compact.lastIndexOf('opening'));
  const tail = start >= 0 ? compact.slice(start) : compact;
  return tail.includes('esctointerrupt');
}

export function isPromptDrawn(screen: string): boolean {
  const compact = screen.replace(/\x1b\[[0-9;?<>]*[A-Za-z~]/g, '').replace(/\s+/g, '');
  const start = Math.max(compact.lastIndexOf('Wakingsession'), compact.lastIndexOf('Attaching'), compact.lastIndexOf('opening'));
  const tail = start >= 0 ? compact.slice(start) : compact;
  return tail.includes('foragents') || tail.includes('shift+tabtocycle');
}

async function openViaAgentView(
  term: IPty,
  getScreen: () => string,
  resetScreen: () => void,
  getLastOutputAt: () => number,
  isExited: () => boolean,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const start = Date.now();
  let trustAnswered = false;
  while (Date.now() - start < AGENT_VIEW_READY_MS && !isExited()) {
    await sleep(300);
    const compact = compactScreen(getScreen());
    if (!trustAnswered && compact.includes('Yes,Itrustthisfolder') && !compact.includes('describeataskforanewsession')) {
      trustAnswered = await answerFolderTrust(term, getScreen, getLastOutputAt);
      if (!trustAnswered) {
        return { ok: false, error: 'Could not confirm the folder in agent view.' };
      }
      continue;
    }
    if (compact.includes('describeataskforanewsession')) {
      await sleep(500);
      return (await openJobFromAgentView(term, getScreen, resetScreen, name))
        ? { ok: true }
        : { ok: false, error: `Agent view did not find the job "${name}".` };
    }
  }
  return { ok: false, error: 'Claude Code agent view did not open.' };
}

async function isJobAwake(jobId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await liveSessionsService.refresh();
    if (liveSessionsService.list().some((entry) => entry.jobId === jobId && entry.alive)) {
      return true;
    }
    await sleep(1_000);
  }
  return false;
}

/**
 * Used by the websocket module to send a chat turn (and a scheduled message)
 * into the daemon job that owns the conversation.
 */
export function deliverToJob(input: {
  jobId: string;
  text: string;
  cwd?: string | null;
  transcriptPath?: string | null;
}): Promise<{ delivered: boolean; error: string | null }> {
  const { jobId } = input;
  if (!SAFE_JOB_ID.test(jobId)) {
    return Promise.resolve({ delivered: false, error: 'Invalid job id.' });
  }
  const text = sanitizeForPaste(input.text);
  if (!text.trim()) {
    return Promise.resolve({ delivered: false, error: 'Empty message.' });
  }

  return enqueue(jobId, async () => {
    let result: AttachAttempt = { delivered: false, error: null, pasted: false };
    let viaAgentView = false;
    for (let attempt = 1; attempt <= ATTACH_ATTEMPTS; attempt += 1) {
      result = await attachAndPaste(jobId, text, input.cwd, input.transcriptPath, viaAgentView);
      if (!result.delivered && result.homeNotTrusted && !viaAgentView) {
        // A job in the home folder cannot be woken by `claude attach`: Claude
        // Code trusts the home one interactive session at a time. Agent view
        // can (it asks for that trust), so the next attempt goes through it.
        viaAgentView = true;
        attempt -= 1;
        continue;
      }
      if (result.delivered) {
        return { delivered: true, error: null };
      }
      console.warn(`[live-sessions] delivery to job ${jobId} failed (attempt ${attempt}): ${result.error}`);
      // Once the text was pasted, retrying could send it twice.
      if (result.pasted) {
        break;
      }
    }
    return { delivered: false, error: result.error };
  });
}

type AttachAttempt = { delivered: boolean; error: string | null; pasted: boolean; homeNotTrusted?: boolean };

/**
 * In agent view (already past the folder question): find the job by its name
 * with ctrl+f and open it, which wakes it with agent view's trust. False when
 * the search does not find it.
 */
async function openJobFromAgentView(term: IPty, getScreen: () => string, resetScreen: () => void, name: string): Promise<boolean> {
  term.write('\x06'); // ctrl+f: find
  await sleep(500);
  term.write(name);
  await sleep(1_500);
  const compact = compactScreen(getScreen());
  const afterSearch = compact.slice(compact.lastIndexOf('⌕'));
  if (afterSearch.includes('nosessionsmatch') || !afterSearch.includes(name.replace(/\s+/g, ''))) {
    return false;
  }
  resetScreen();
  term.write('\r'); // open the first match
  return true;
}

async function attachAndPaste(
  jobId: string,
  text: string,
  cwd: string | null | undefined,
  transcriptPath: string | null | undefined,
  viaAgentView = false,
): Promise<AttachAttempt> {
  {
    const jobName = liveSessionsService.list().find((entry) => entry.jobId === jobId)?.name ?? null;
    if (viaAgentView && !jobName) {
      return { delivered: false, error: 'The job has no name to find it in agent view.', pasted: false };
    }
    const sizeBefore = await fileSize(transcriptPath);
    let screen = '';
    let lastOutputAt = 0;
    let exited = false;
    const startedAt = Date.now();

    let term: IPty;
    try {
      term = spawnPtyImpl(cliPath(), viaAgentView ? ['agents'] : ['attach', jobId], {
        name: 'xterm-256color',
        cols: viaAgentView ? 140 : 120,
        rows: 40,
        cwd: cwd || process.env.HOME || '/',
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (error) {
      return { delivered: false, error: `Could not start claude attach: ${String(error)}`, pasted: false };
    }

    term.onData((data) => {
      lastOutputAt = Date.now();
      screen = (screen + data).slice(-50_000);
    });
    term.onExit(() => {
      exited = true;
    });

    try {
      if (viaAgentView) {
        const opened = await openViaAgentView(term, () => screen, () => { screen = ''; }, () => lastOutputAt, () => exited, jobName as string);
        if (!opened.ok) {
          return { delivered: false, error: opened.error, pasted: false };
        }
      }
      const ready = await waitForAttachReady(() => lastOutputAt, () => screen, () => exited, startedAt, term);
      if (!ready) {
        const homeNotTrusted = compactScreen(screen).includes('Workspacenottrusted');
        return {
          delivered: false,
          error: exited
            ? `claude attach exited before the session was ready${homeNotTrusted ? ' (home folder not trusted)' : ''}.`
            : `The job did not wake up within ${RENDER_MAX_WAIT_MS / 1000} s (screen: …${compactScreen(screen).slice(-160)}).`,
          pasted: false,
          homeNotTrusted,
        };
      }
      if (viaAgentView && !(await isJobAwake(jobId))) {
        // Same name, different job: never type into the wrong conversation.
        return { delivered: false, error: 'Agent view opened a different session with the same name.', pasted: false };
      }

      term.write(`\x1b[200~${text}\x1b[201~`);
      await sleep(400);
      term.write('\r');

      // With no transcript to watch there is nothing to confirm against.
      let confirmed = sizeBefore === null;
      const confirmStart = Date.now();
      while (!confirmed && Date.now() - confirmStart < CONFIRM_MAX_WAIT_MS) {
        await sleep(500);
        const size = await fileSize(transcriptPath);
        confirmed = size !== null && sizeBefore !== null && size > sizeBefore;
      }

      if (!confirmed && !exited) {
        // The text may still sit in the input (Enter arrived during a redraw):
        // one more Enter submits it; on an empty input it does nothing.
        term.write('\r');
        const secondStart = Date.now();
        while (!confirmed && Date.now() - secondStart < 20_000) {
          await sleep(500);
          const size = await fileSize(transcriptPath);
          confirmed = size !== null && sizeBefore !== null && size > sizeBefore;
        }
      }

      if (!exited) {
        term.write('\x1a'); // Ctrl+Z detaches; the job keeps running.
        await sleep(500);
      }

      return confirmed
        ? { delivered: true, error: null, pasted: true }
        : { delivered: false, error: 'The job did not record the message in time.', pasted: true };
    } finally {
      if (!exited) {
        try {
          term.kill();
        } catch {
          // already gone
        }
      }
      void liveSessionsService.refresh();
    }
  }
}

const AGENT_VIEW_READY_MS = 45_000;
const NEW_JOB_DISCOVERY_MS = 45_000;
const SAFE_MODEL_OPTION = /^[A-Za-z0-9._:[\]-]{1,80}$/;

/** Screen text with escape sequences and all whitespace removed, for robust matching. */
function compactScreen(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?<>]*[A-Za-z~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\s+/g, '');
}

async function waitForQuiet(getLastOutputAt: () => number, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(100);
    if (Date.now() - getLastOutputAt() >= quietMs) {
      return;
    }
  }
}

/**
 * Picks "Yes, I trust this folder" in the folder question. The menu can
 * redraw with its default ("No, exit") right after it appears, so Enter is
 * pressed only once the latest drawn selection is really "Yes".
 */
async function answerFolderTrust(term: IPty, getScreen: () => string, getLastOutputAt: () => number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForQuiet(getLastOutputAt, 700, 5_000);
    const compact = compactScreen(getScreen());
    const yesSelected = compact.lastIndexOf('❯Yes,Itrustthisfolder');
    const noSelected = compact.lastIndexOf('❯No,exit');
    if (yesSelected > noSelected) {
      term.write('\r');
      return true;
    }
    term.write('\x1b[B');
    await sleep(400);
  }
  return false;
}

/**
 * Used by the websocket module for the first message of a chat created in the
 * app: the conversation is started as a Claude Code daemon job, exactly as
 * agent view starts one, so it appears in `claude agents` like every other
 * job. Agent view is also the only official way to start a job in the home
 * folder, which Claude Code trusts one session at a time: its folder
 * question is answered "Yes" for that session only, for an app project the
 * user already opened. Returns the new conversation's provider session id.
 */
export async function startJobFromAgentView(input: {
  cwd: string;
  prompt: string;
  model?: string | null;
  effort?: string | null;
}): Promise<{ providerSessionId: string; jobId: string | null }> {
  const prompt = sanitizeForPaste(input.prompt);
  if (!prompt.trim()) {
    throw new AppError('Empty message.', { code: 'EMPTY_MESSAGE', statusCode: 400 });
  }

  await liveSessionsService.refresh();
  const known = new Set(liveSessionsService.list().map((entry) => entry.sessionId));

  const args = ['agents'];
  if (input.model && SAFE_MODEL_OPTION.test(input.model)) {
    args.push('--model', input.model);
  }
  if (input.effort && SAFE_MODEL_OPTION.test(input.effort)) {
    args.push('--effort', input.effort);
  }

  let screen = '';
  let exited = false;
  const term = spawnPtyImpl(cliPath(), args, {
    name: 'xterm-256color',
    cols: 140,
    rows: 45,
    cwd: input.cwd,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  });
  let lastOutputAt = 0;
  term.onData((data) => {
    // Only the recent part matters; keeps memory flat while agent view animates.
    screen = (screen + data).slice(-200_000);
    lastOutputAt = Date.now();
  });
  term.onExit(() => {
    exited = true;
  });

  try {
    let trustAnswered = false;
    let ready = false;
    const readyStart = Date.now();
    while (!ready && !exited && Date.now() - readyStart < AGENT_VIEW_READY_MS) {
      await sleep(300);
      const compact = compactScreen(screen);
      if (!trustAnswered && compact.includes('Yes,Itrustthisfolder') && !compact.includes('describeataskforanewsession')) {
        trustAnswered = await answerFolderTrust(term, () => screen, () => lastOutputAt);
        if (!trustAnswered) {
          throw new AppError('Could not confirm the folder in Claude Code agent view.', {
            code: 'AGENT_VIEW_TRUST_FAILED',
            statusCode: 422,
          });
        }
        continue;
      }
      ready = compact.includes('describeataskforanewsession');
    }
    if (!ready) {
      const tail = compactScreen(screen).slice(-300);
      console.warn(`[live-sessions] agent view not ready in ${input.cwd} (exited=${exited}): …${tail}`);
      throw new AppError('Claude Code agent view did not open in this folder.', {
        code: 'AGENT_VIEW_NOT_READY',
        statusCode: 422,
      });
    }

    await sleep(500);
    term.write(`\x1b[200~${prompt}\x1b[201~`);
    await sleep(400);
    term.write('\r');

    const resolvedCwd = path.resolve(input.cwd);
    const discoveryStart = Date.now();
    while (Date.now() - discoveryStart < NEW_JOB_DISCOVERY_MS) {
      await sleep(1_000);
      await liveSessionsService.refresh();
      const created = liveSessionsService.list().find((entry) => (
        !known.has(entry.sessionId)
        && entry.kind === 'background'
        && entry.cwd !== null
        && path.resolve(entry.cwd) === resolvedCwd
      ));
      if (created) {
        return { providerSessionId: created.sessionId, jobId: created.jobId };
      }
    }
    throw new AppError('The new background job did not appear in claude agents in time.', {
      code: 'JOB_NOT_FOUND',
      statusCode: 422,
    });
  } finally {
    if (!exited) {
      term.write('\x03'); // Leave agent view; the dispatched job keeps running.
      await sleep(500);
      try {
        term.kill();
      } catch {
        // already gone
      }
    }
  }
}

function runCli(args: string[], cwd?: string | null): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      cliPath(),
      args,
      { cwd: cwd || process.env.HOME || '/', timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${String(stdout)}\n${String(stderr)}`.replace(ANSI_SEQUENCE, '').trim();
        resolve({ code: error ? 1 : 0, output });
      },
    );
  });
}

/**
 * Used by the live-sessions routes: starts a new background job in one of the
 * app's known projects and returns the short id the CLI printed. Only known
 * project folders are accepted, because the job runs with the server's
 * privileges.
 */
export async function startJobInProject(input: { projectPath: string; prompt: string; name?: string | null }): Promise<string> {
  if (!projectsDb.getProjectPath(input.projectPath)) {
    throw new AppError('Unknown project.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }

  const args = ['--bg'];
  if (input.name && input.name.trim()) {
    args.push('--name', input.name.trim().slice(0, 80));
  }
  args.push(input.prompt);

  const result = await runCli(args, input.projectPath);
  void liveSessionsService.refresh();

  const match = result.output.match(/backgrounded\s*·\s*([A-Za-z0-9_-]+)/);
  if (!match) {
    // e.g. "Workspace not trusted": the folder must be trusted in Claude Code first.
    throw new AppError(result.output.split('\n').slice(0, 3).join(' ') || 'claude --bg failed.', {
      code: 'JOB_START_FAILED',
      statusCode: 422,
    });
  }
  return match[1];
}

type JobQuestion = {
  question: string;
  multiSelect?: boolean;
  options?: { label: string }[];
};

/**
 * @internal The key presses that answer AskUserQuestion's menu in a job,
 * one step per entry; exported only for the module's tests. Claude Code
 * numbers the options from 1 and puts "Type something" after them. A number
 * picks a single-choice option and moves on; in a multiple-choice question it
 * ticks the option, and Tab moves on. Typed text in a multiple-choice
 * question is not reliably taken by the menu, so it is refused.
 * `answers` is the web panel's: question text -> label, or labels joined by
 * ", ", or typed text.
 */
export function questionKeys(
  questions: JobQuestion[],
  answers: Record<string, string>,
): { keys: string[] } | { error: string } {
  const keys: string[] = [];
  for (const question of questions) {
    const labels = (question.options ?? []).map((option) => option.label);
    const answer = (answers[question.question] ?? '').trim();
    if (!answer) {
      return { error: `No answer for "${question.question}".` };
    }
    if (question.multiSelect) {
      const parts = answer.split(', ');
      const unknown = parts.filter((part) => !labels.includes(part));
      if (unknown.length > 0) {
        return { error: 'Typed answers to a multiple-choice question can only be given in the terminal.' };
      }
      for (const part of parts) {
        keys.push(String(labels.indexOf(part) + 1));
      }
      keys.push('\t');
      continue;
    }
    const index = labels.indexOf(answer);
    if (index >= 0) {
      keys.push(String(index + 1));
    } else {
      // "Type something": its number opens the text field, Enter confirms.
      keys.push(String(labels.length + 1), sanitizeForPaste(answer).replace(/\n/g, ' '), '\r');
    }
  }
  return { keys };
}

const QUESTION_READY_MS = 90_000;
const KEY_PAUSE_MS = 800;

/**
 * Used by the live-sessions routes: answers the question (AskUserQuestion)
 * a daemon job is waiting on, by pressing its menu keys in `claude attach`.
 * Every key goes in one attach: a new attach shows the menu from the start.
 * The final "Submit answers" is pressed only when the review screen is drawn,
 * so a stray "1" never lands in the job's input.
 */
export async function answerJobQuestion(input: {
  sessionId: string;
  questions: JobQuestion[];
  answers: Record<string, string>;
}): Promise<void> {
  const session = sessionsDb.getSessionById(input.sessionId);
  const route = resolveLiveRoute(session);
  if (route.mode !== 'job' || !SAFE_JOB_ID.test(route.jobId)) {
    throw new AppError('This session is not a background job.', { code: 'NOT_A_JOB', statusCode: 400 });
  }
  const plan = questionKeys(input.questions, input.answers);
  if ('error' in plan) {
    throw new AppError(plan.error, { code: 'QUESTION_ANSWER_UNSUPPORTED', statusCode: 422 });
  }
  const jobId = route.jobId;
  // The start is enough to know the menu is this question; a long one wraps.
  const firstQuestion = compactScreen(input.questions[0]?.question ?? '').slice(0, 30);

  const error = await enqueue(jobId, async () => {
    const sizeBefore = await fileSize(session?.jsonl_path);
    let screen = '';
    let exited = false;
    let term: IPty;
    try {
      term = spawnPtyImpl(cliPath(), ['attach', jobId], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: session?.project_path || process.env.HOME || '/',
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (spawnError) {
      return `Could not start claude attach: ${String(spawnError)}`;
    }
    term.onData((data) => {
      screen = (screen + data).slice(-50_000);
    });
    term.onExit(() => {
      exited = true;
    });

    try {
      const startedAt = Date.now();
      let ready = false;
      while (!ready && !exited && Date.now() - startedAt < QUESTION_READY_MS) {
        await sleep(300);
        const compact = compactScreen(screen);
        ready = compact.includes('Entertoselect') && (!firstQuestion || compact.includes(firstQuestion));
      }
      if (!ready) {
        return 'The job is not showing this question (it may have been answered already).';
      }
      await sleep(KEY_PAUSE_MS);
      for (const key of plan.keys) {
        term.write(key);
        await sleep(KEY_PAUSE_MS);
      }
      // One question goes out on its own; several end on a review screen.
      const reviewStart = Date.now();
      while (Date.now() - reviewStart < 4_000) {
        if (compactScreen(screen).includes('Readytosubmityouranswers')) {
          term.write('1');
          break;
        }
        await sleep(300);
      }

      let confirmed = sizeBefore === null;
      const confirmStart = Date.now();
      while (!confirmed && Date.now() - confirmStart < CONFIRM_MAX_WAIT_MS) {
        await sleep(500);
        const size = await fileSize(session?.jsonl_path);
        confirmed = size !== null && sizeBefore !== null && size > sizeBefore;
      }
      if (!exited) {
        term.write('\x1a'); // Ctrl+Z detaches; the job keeps running.
        await sleep(500);
      }
      return confirmed ? null : 'The job did not record the answer in time.';
    } finally {
      if (!exited) {
        try {
          term.kill();
        } catch {
          // already gone
        }
      }
      void liveSessionsService.refresh();
    }
  });
  if (error) {
    throw new AppError(error, { code: 'QUESTION_ANSWER_FAILED', statusCode: 422 });
  }
}

/**
 * Used by the live-sessions routes: stops the daemon job behind an app
 * session. Its conversation is kept and can be resumed by sending to it.
 */
export async function stopJobForSession(sessionId: string): Promise<void> {
  const route = resolveLiveRoute(sessionsDb.getSessionById(sessionId));
  if (route.mode !== 'job' || !SAFE_JOB_ID.test(route.jobId)) {
    throw new AppError('This session is not a background job.', { code: 'NOT_A_JOB', statusCode: 400 });
  }

  const result = await runCli(['stop', route.jobId]);
  void liveSessionsService.refresh();
  if (result.code !== 0) {
    throw new AppError(result.output || 'claude stop failed.', { code: 'JOB_STOP_FAILED', statusCode: 422 });
  }
}
