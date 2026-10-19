import fs from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { deliverToJob } from '@/modules/live-sessions/services/live-inject.service.js';
import { resolveLiveRoute } from '@/modules/live-sessions/services/live-routing.service.js';
import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * Keeps conversation names identical to the ones Claude Code shows.
 *
 * Claude Code's own precedence, verified against `claude agents` for every
 * job on this machine: the daemon job's name (`state.json`), then the latest
 * `custom-title` record in the transcript (what `/rename` writes), then
 * `agent-name`, then the automatic `ai-title`.
 */

// Title records are re-written on every turn, so the latest ones sit near the
// end; scanning this much from the end finds them without reading 40 MB files.
const TITLE_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const MAX_NAME_LENGTH = 200;

type TranscriptTitles = { custom?: string; agent?: string; ai?: string };

/** @internal Latest title records of one transcript; exported only for the module's tests. */
export async function readTranscriptTitles(transcriptPath: string): Promise<TranscriptTitles> {
  const titles: TranscriptTitles = {};
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(transcriptPath, 'r');
    const { size } = await handle.stat();
    const stopAt = Math.max(0, size - TITLE_SCAN_BYTES);
    let position = size;
    let carry = '';

    while (position > stopAt && !titles.custom) {
      const length = Math.min(CHUNK_BYTES, position - stopAt);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const text = buffer.toString('utf8') + carry;
      const lines = text.split('\n');
      // The first piece may be a partial line; keep it for the next chunk.
      carry = position > stopAt ? (lines.shift() ?? '') : '';

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || !line.includes('"type":"')) {
          continue;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === 'custom-title' && !titles.custom && typeof event.customTitle === 'string' && event.customTitle.trim()) {
          titles.custom = event.customTitle.trim();
        } else if (event.type === 'agent-name' && !titles.agent && typeof event.agentName === 'string' && event.agentName.trim()) {
          titles.agent = event.agentName.trim();
        } else if (event.type === 'ai-title' && !titles.ai && typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
          titles.ai = event.aiTitle.trim();
        }
      }
    }
  } catch {
    // Missing or unreadable transcript: no Claude Code name to report.
  } finally {
    await handle?.close();
  }
  return titles;
}

/**
 * Used by the providers module's Claude session synchronizer: the name Claude
 * Code shows for a conversation, or null when it has none yet (the caller
 * then falls back to its own default).
 */
export async function resolveClaudeSessionName(
  providerSessionId: string,
  transcriptPath: string | null | undefined,
): Promise<string | null> {
  const live = liveSessionsService.get(providerSessionId);
  if (live?.kind === 'background' && live.name) {
    return live.name;
  }
  if (!transcriptPath) {
    return null;
  }
  const titles = await readTranscriptTitles(transcriptPath);
  return titles.custom ?? titles.agent ?? titles.ai ?? null;
}

/**
 * Used by server startup on every live-state change: when the daemon renames
 * a job, the app's stored name follows. Returns the provider ids whose stored
 * name changed.
 */
export function syncJobNamesToDb(providerSessionIds: string[]): string[] {
  const changed: string[] = [];
  for (const providerSessionId of providerSessionIds) {
    const live = liveSessionsService.get(providerSessionId);
    if (live?.kind !== 'background' || !live.name) {
      continue;
    }
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (row && row.custom_name !== live.name) {
      sessionsDb.updateSessionCustomName(row.session_id, live.name);
      changed.push(providerSessionId);
    }
  }
  return changed;
}

/**
 * Used by server startup, once: re-derives every stored Claude conversation
 * name. The startup sync only revisits transcripts changed since its last
 * scan, so names stored before this rule existed would otherwise never
 * change. Returns the provider ids whose stored name changed.
 */
export async function refreshAllClaudeSessionNames(): Promise<string[]> {
  const changed: string[] = [];
  for (const row of sessionsDb.getAllSessions()) {
    const providerSessionId = row.provider_session_id ?? row.session_id;
    if (row.provider !== 'claude' || !providerSessionId) {
      continue;
    }
    const name = await resolveClaudeSessionName(providerSessionId, row.jsonl_path);
    if (name && name !== row.custom_name) {
      sessionsDb.updateSessionCustomName(row.session_id, name);
      changed.push(providerSessionId);
    }
  }
  return changed;
}

/**
 * Used by the providers module before it stores a rename made in the app:
 * the new name is written to Claude Code first, so both sides keep showing
 * the same one. A daemon job is renamed with its own `/rename` command; a
 * conversation no process owns gets the records `/rename` would write; one
 * open in a terminal cannot be changed from here.
 */
export async function renameClaudeSession(
  row: { provider?: string | null; session_id?: string | null; provider_session_id?: string | null; jsonl_path?: string | null; project_path?: string | null },
  name: string,
): Promise<void> {
  if ((row.provider ?? 'claude') !== 'claude') {
    return;
  }
  // One line: the name travels inside a slash command and a JSON record.
  const cleanName = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (!cleanName) {
    return;
  }

  const route = resolveLiveRoute(row);
  if (route.mode === 'interactive') {
    throw new AppError('This conversation is open in a terminal. Rename it there with /rename.', {
      code: 'LIVE_RENAME_IN_TERMINAL',
      statusCode: 409,
    });
  }

  if (route.mode === 'job') {
    const result = await deliverToJob({
      jobId: route.jobId,
      text: `/rename ${cleanName}`,
      cwd: row.project_path,
      transcriptPath: row.jsonl_path,
    });
    if (!result.delivered) {
      throw new AppError(result.error ?? 'Could not rename the background job.', {
        code: 'LIVE_RENAME_FAILED',
        statusCode: 422,
      });
    }
    void liveSessionsService.refresh();
    return;
  }

  const sessionId = row.provider_session_id ?? row.session_id;
  if (!row.jsonl_path || !sessionId) {
    return;
  }
  const records = [
    { type: 'custom-title', customTitle: cleanName, sessionId },
    { type: 'agent-name', agentName: cleanName, sessionId },
  ];
  // Never glue the records onto a last line that lacks its newline.
  const needsLeadingNewline = await endsWithoutNewline(row.jsonl_path);
  const payload = `${needsLeadingNewline ? '\n' : ''}${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await fs.appendFile(row.jsonl_path, payload, 'utf8');
}

async function endsWithoutNewline(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) {
      return false;
    }
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
