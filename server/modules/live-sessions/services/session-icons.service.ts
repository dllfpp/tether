import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveLiveRoute } from '@/modules/live-sessions/services/live-routing.service.js';
import { renameClaudeSession } from '@/modules/live-sessions/services/claude-session-names.service.js';
import { isHiddenProjectPath, liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';

/**
 * CloudCLI live: puts an icon for the topic at the start of every Claude
 * conversation name that has none, a minute after the conversation started.
 * The icon comes from keywords in the name (no model call, no tokens). The
 * rename goes into Claude Code itself, through the same path as a rename
 * from the web: `/rename` for a job, the title records for a stopped chat.
 */

// First match wins: the more specific topics come first.
const ICON_RULES: Array<[RegExp, string]> = [
  [/\b(amazon|ordin\w*|acquist\w*|shop|prezz\w*)\b/i, '🛒'],
  [/\b(viaggio|itinerar\w*|trip|mappa|maps)\b/i, '🧭'],
  [/\b(alexa|menu|mensa|ricett\w*|ristorant\w*|restaurant\w*)\b/i, '🍽️'],
  [/\b(pfsense|firewall|vpn|wireguard)\b/i, '🛡️'],
  [/\b(switch|vlan|omada|unifi|wi-?fi|ssid|ap|router|rete|network|porte?)\b/i, '🖥️'],
  [/\b(ram|memoria|proxmox|pve\d*|lxc|vm|container|docker|staging|server|ssh|terminal)\b/i, '🗄️'],
  [/\b(dns|pi-?hole|npm|nginx|cloudflare|dominio|domain|certificat\w*)\b/i, '🌐'],
  [/\b(log|security|sicurezza|attacc\w*|password|secret\w*)\b/i, '🔒'],
  [/\b(telegram|bot|chatbot|n8n|workflow|automazion\w*)\b/i, '🤖'],
  [/\b(home ?assistant|ha|hacs|domotic\w*|clima)\b/i, '🏠'],
  [/\b(tesla|auto|car)\b/i, '🚗'],
  [/\b(consum\w*|acqua|gas|termic\w*|fotovolta\w*|solar|inverter|energia)\b/i, '⚡'],
  [/\b(video|youtube|download\w*|media|foto|immagin\w*)\b/i, '🎬'],
  [/\b(pdf|document\w*|doc|report|readme|email)\b/i, '📄'],
  [/\b(dashboard|grafic\w*|token|statistic\w*|monitor\w*)\b/i, '📊'],
  [/\b(sito|site|website|landing|pagina|web ?app|ui|design|frontend)\b/i, '🎨'],
  [/\b(tether|claude|skill\w*|mcp|agent\w*|llm\w*)\b/i, '🧠'],
  [/\b(git(hub)?|repo|release|merge|pr)\b/i, '🔀'],
  [/\b(test|debug|bug|fix|errore|error)\b/i, '🐞'],
];

const LEADING_ICON = /^\p{Extended_Pictographic}/u;
const START_DELAY_MS = 60_000;
const TICK_MS = 60_000;
// Renaming a job wakes it through `claude attach`: a few per minute at most.
const MAX_JOB_RENAMES_PER_TICK = 2;
const MAX_FILE_RENAMES_PER_TICK = 20;

/** @internal The icon for a conversation name, or null when no topic matches; exported for the tests. */
export function iconForName(name: string): string | null {
  for (const [pattern, icon] of ICON_RULES) {
    if (pattern.test(name)) return icon;
  }
  return null;
}

/** @internal True when the name already starts with an emoji; exported for the tests. */
export function hasLeadingIcon(name: string): boolean {
  return LEADING_ICON.test(name.trim());
}

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Renames a stopped daemon job in its own state.json (what `/rename` writes:
 * `name` plus `nameSource: user`). `updatedAt` is left alone, so the job does
 * not look freshly changed. False when the file is missing, or holds another
 * name than the one expected (it changed meanwhile).
 */
async function renameStoppedJob(jobId: string, expectedName: string, nextName: string): Promise<boolean> {
  if (!SAFE_JOB_ID.test(jobId)) return false;
  const stateFile = path.join(os.homedir(), '.claude', 'jobs', jobId, 'state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (typeof state.name !== 'string' || state.name.trim() !== expectedName) return false;
  state.name = nextName;
  state.nameSource = 'user';
  const temporary = `${stateFile}.tether-icon`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2));
  await fs.rename(temporary, stateFile);
  return true;
}

// Conversations that matched no rule or failed once: not retried until restart.
const settled = new Set<string>();
let running = false;

async function tick(onRenamed: (providerSessionIds: string[]) => void): Promise<void> {
  if (running) return;
  running = true;
  const renamed: string[] = [];
  try {
    let jobRenames = 0;
    let fileRenames = 0;
    for (const row of sessionsDb.getAllSessions()) {
      const providerSessionId = row.provider_session_id ?? row.session_id;
      const name = row.custom_name?.trim();
      if (row.provider !== 'claude' || !name || settled.has(row.session_id)) continue;
      if (isHiddenProjectPath(row.project_path) || hasLeadingIcon(name)) continue;
      const createdAt = Date.parse(row.created_at);
      if (Number.isFinite(createdAt) && Date.now() - createdAt < START_DELAY_MS) continue;

      const icon = iconForName(name);
      if (!icon) {
        settled.add(row.session_id);
        continue;
      }

      const route = resolveLiveRoute(row);
      // A terminal session cannot be renamed from here; try again later.
      if (route.mode === 'interactive') continue;
      if (route.mode === 'job') {
        // Attaching to a stopped job would restart it: its name is written
        // straight into the job's state.json instead, as `/rename` would.
        const live = liveSessionsService.get(providerSessionId);
        if (!live?.alive) {
          if (fileRenames >= MAX_FILE_RENAMES_PER_TICK) continue;
          fileRenames += 1;
          const nextName = `${icon} ${name}`;
          try {
            if (await renameStoppedJob(route.jobId, name, nextName)) {
              sessionsDb.updateSessionCustomName(row.session_id, nextName);
              renamed.push(providerSessionId);
            } else {
              settled.add(row.session_id);
            }
          } catch (error) {
            settled.add(row.session_id);
            console.warn(`[live-sessions] icon for job "${name}" not set:`, error instanceof Error ? error.message : error);
          }
          continue;
        }
        // Mid-turn, `/rename` would wait in the job's queue: rename between turns.
        const state = live.state;
        if (state === 'working' || state === 'running' || jobRenames >= MAX_JOB_RENAMES_PER_TICK) continue;
        jobRenames += 1;
      } else {
        if (fileRenames >= MAX_FILE_RENAMES_PER_TICK) continue;
        fileRenames += 1;
      }

      const nextName = `${icon} ${name}`;
      try {
        await renameClaudeSession(row, nextName);
        sessionsDb.updateSessionCustomName(row.session_id, nextName);
        renamed.push(providerSessionId);
      } catch (error) {
        settled.add(row.session_id);
        console.warn(`[live-sessions] icon for "${name}" not set:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    running = false;
  }
  if (renamed.length > 0) {
    console.log(`[live-sessions] topic icon added to ${renamed.length} conversation(s)`);
    onRenamed(renamed);
  }
}

/**
 * Used by server startup: checks every minute for conversations without a
 * topic icon. `onRenamed` publishes the new names to the open clients.
 */
export function startSessionIcons(onRenamed: (providerSessionIds: string[]) => void): void {
  if (process.env.LIVE_SESSION_ICONS === '0') return;
  setInterval(() => {
    void tick(onRenamed).catch((error) => console.warn('[live-sessions] session icons failed:', error));
  }, TICK_MS).unref();
}
