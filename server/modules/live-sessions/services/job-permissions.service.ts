import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * CloudCLI live: the permission prompts of daemon jobs ("Do you want to
 * proceed?"), shown in the chat. Claude Code runs a PermissionRequest hook
 * (deploy/live/permission-hook.sh) when a job is about to ask; the hook posts
 * here and waits. The question goes to every client as a `permission_request`
 * of the job's conversation, and the first answer goes back as the hook's
 * decision. Unanswered, the hook gets no decision and Claude Code carries on
 * as without it (its own prompt and auto-deny).
 */

/** How long a prompt waits for an answer from the chat; the hook's own timeout is longer. */
const WAIT_MS = 110_000;

type PendingPrompt = {
  appSessionId: string;
  toolName: string;
  input: unknown;
  resolve: (allow: boolean | null) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, PendingPrompt>();

// The websocket module hands in its broadcast (it depends on this module, not
// the other way round).
let broadcast: (frame: unknown) => void = () => undefined;

/** Used by the websocket module at startup: how to reach every open client. */
export function setJobPermissionBroadcast(send: (frame: unknown) => void): void {
  broadcast = send;
}

function send(frame: unknown): void {
  broadcast(frame);
}

function frame(kind: 'permission_request' | 'permission_resolved' | 'permission_cancelled', requestId: string, prompt: PendingPrompt) {
  return createNormalizedMessage({
    kind,
    requestId,
    toolName: prompt.toolName,
    input: prompt.input,
    sessionId: prompt.appSessionId,
    provider: 'claude',
  });
}

/** A short line for the push: the command, or the tool name. */
function describe(toolName: string, toolInput: unknown): string {
  const command = (toolInput as { command?: unknown } | null)?.command;
  const text = typeof command === 'string' && command.trim() ? command.trim() : toolName;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** The phone and desktop are told at once: the prompt waits less than two minutes. */
function notifyPrompt(appSessionId: string, name: string | null, toolName: string, toolInput: unknown): void {
  const user = userDb.getFirstUser();
  if (!user) return;
  type EventInput = Parameters<typeof createNotificationEvent>[0];
  notifyUserIfEnabled({
    userId: user.id,
    event: createNotificationEvent(<EventInput><unknown>{
      provider: 'claude',
      sessionId: appSessionId,
      kind: 'action_required',
      code: 'agent.notification',
      meta: { message: `Permission needed: ${describe(toolName, toolInput)}`, sessionName: name },
      severity: 'info',
      requiresUserAction: true,
    }),
  });
}

/** Where the shared secret of the hook lives (600), next to the database. */
export function jobPermissionTokenFile(): string {
  const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
  return path.join(path.dirname(databasePath), 'job-permission-hook.token');
}

/** Used by server startup: the token the hook sends, created once. */
export function ensureJobPermissionToken(): string {
  const file = jobPermissionTokenFile();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // first start
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Used by the hook route: asks the chat of the job's conversation and waits.
 * Resolves true/false with the answer, or null when nobody answered (or the
 * conversation is not one Tether knows).
 */
export async function requestJobPermission(input: { providerSessionId: string; toolName: string; toolInput: unknown }): Promise<boolean | null> {
  // A job that asks in its first seconds may not be indexed yet: wait a little.
  let row = null;
  for (let attempt = 0; attempt < 30 && !row; attempt += 1) {
    row = sessionsDb.getSessionByProviderSessionId(input.providerSessionId)
      ?? sessionsDb.getSessionById(input.providerSessionId);
    if (!row) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!row) {
    console.warn(`[job-permissions] ${input.toolName} prompt for unknown conversation ${input.providerSessionId}`);
    return null;
  }
  console.log(`[job-permissions] ${input.toolName} prompt for ${row.session_id} shown in the chat`);
  const requestId = `job-permission:${crypto.randomUUID()}`;
  return await new Promise<boolean | null>((resolve) => {
    const prompt: PendingPrompt = {
      appSessionId: row.session_id,
      toolName: input.toolName,
      input: input.toolInput,
      resolve,
      timer: setTimeout(() => {
        pending.delete(requestId);
        send(frame('permission_cancelled', requestId, prompt));
        resolve(null);
      }, WAIT_MS),
    };
    pending.set(requestId, prompt);
    send(frame('permission_request', requestId, prompt));
    notifyPrompt(row.session_id, row.custom_name ?? null, input.toolName, input.toolInput);
  });
}

/** Used by the chat websocket: true when the answer was for a job prompt (and is now delivered). */
export function answerJobPermission(requestId: string, allow: boolean): boolean {
  const prompt = pending.get(requestId);
  if (!prompt) return false;
  pending.delete(requestId);
  clearTimeout(prompt.timer);
  send(frame('permission_resolved', requestId, prompt));
  prompt.resolve(allow);
  return true;
}

/**
 * Used by the chat websocket's subscribe ack: the open prompts of one
 * conversation, in the ack's pendingPermissions shape (the client replaces its
 * list with that one, so they must be in it).
 */
export function pendingJobPermissions(appSessionId: string): Array<{ requestId: string; toolName: string; input: unknown; sessionId: string }> {
  return [...pending.entries()]
    .filter(([, prompt]) => prompt.appSessionId === appSessionId)
    .map(([requestId, prompt]) => ({ requestId, toolName: prompt.toolName, input: prompt.input, sessionId: appSessionId }));
}
