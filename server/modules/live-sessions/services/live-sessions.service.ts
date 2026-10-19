import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LiveSessionInfo } from '@/shared/types.js';

/**
 * Knows which Claude Code conversations on this machine are owned by a live
 * process — background jobs run by the Claude Code daemon (`claude --bg`,
 * agent view) and interactive terminal sessions — so the rest of the app never
 * starts a second process on a conversation that already has one.
 *
 * Sources, merged by provider session id:
 * - `claude agents --json --all`: pid, short job id, kind, idle/busy;
 * - `~/.claude/jobs/<id>/state.json`: the job's name, state and status line.
 */

type AgentsJsonEntry = {
  pid?: number;
  id?: string;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  name?: string;
  status?: string;
  state?: string;
};

type JobStateFile = {
  state?: string;
  detail?: string;
  name?: string;
  sessionId?: string;
  resumeSessionId?: string;
  daemonShort?: string;
  cwd?: string;
  updatedAt?: string;
};

const POLL_INTERVAL_MS = 5_000;
const AGENTS_TIMEOUT_MS = 20_000;

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Project paths that are machinery, not conversations: claude-mem's observer
 * sessions by default. Extra prefixes come from LIVE_HIDDEN_PATHS (comma
 * separated).
 */
/** Used by the providers module to keep these folders out of the recent conversations feed. */
export function hiddenPathPrefixes(): string[] {
  const defaults = [path.join(os.homedir(), '.claude-mem', 'observer-sessions')];
  const extra = (process.env.LIVE_HIDDEN_PATHS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...defaults, ...extra].map((prefix) => path.resolve(prefix));
}

/**
 * Used by the projects and websocket modules to leave claude-mem's machinery
 * out of the sidebar, and here to skip those processes.
 */
export function isHiddenProjectPath(projectPath: string | null | undefined): boolean {
  if (!projectPath) {
    return false;
  }
  const resolved = path.resolve(projectPath);
  return hiddenPathPrefixes().some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`));
}

function readAgentsJson(): Promise<AgentsJsonEntry[] | null> {
  return new Promise((resolve) => {
    execFile(
      process.env.CLAUDE_CLI_PATH || 'claude',
      ['agents', '--json', '--all'],
      { timeout: AGENTS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          console.warn('[live-sessions] claude agents failed:', error.message);
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolve(Array.isArray(parsed) ? (parsed as AgentsJsonEntry[]) : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

async function readJobStates(): Promise<JobStateFile[] | null> {
  const jobsDir = path.join(claudeHome(), 'jobs');
  let entries: string[];
  try {
    entries = await fs.readdir(jobsDir);
  } catch {
    return null;
  }

  const states = await Promise.all(entries.map(async (entry): Promise<JobStateFile | null> => {
    try {
      const raw = await fs.readFile(path.join(jobsDir, entry, 'state.json'), 'utf8');
      const parsed = JSON.parse(raw) as JobStateFile;
      return { daemonShort: entry, ...parsed };
    } catch {
      return null;
    }
  }));
  return states.filter((state): state is JobStateFile => state !== null);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** @internal Pure merge of both sources; exported only for the module's tests. */
export function mergeLiveSources(
  agents: AgentsJsonEntry[],
  jobs: JobStateFile[],
): Map<string, LiveSessionInfo> {
  const bySession = new Map<string, LiveSessionInfo>();

  for (const job of jobs) {
    const sessionId = nonEmpty(job.resumeSessionId) ?? nonEmpty(job.sessionId);
    if (!sessionId) {
      continue;
    }
    bySession.set(sessionId, {
      jobId: nonEmpty(job.daemonShort),
      kind: 'background',
      alive: false,
      pid: null,
      name: nonEmpty(job.name),
      status: null,
      state: nonEmpty(job.state),
      detail: nonEmpty(job.detail),
      cwd: nonEmpty(job.cwd),
      updatedAt: nonEmpty(job.updatedAt),
    });
  }

  for (const agent of agents) {
    const sessionId = nonEmpty(agent.sessionId);
    if (!sessionId || isHiddenProjectPath(agent.cwd)) {
      continue;
    }
    const kind: LiveSessionInfo['kind'] = agent.kind === 'background' ? 'background' : 'interactive';
    const previous = bySession.get(sessionId);
    const pid = typeof agent.pid === 'number' ? agent.pid : null;
    bySession.set(sessionId, {
      jobId: nonEmpty(agent.id) ?? previous?.jobId ?? null,
      kind: previous?.kind === 'background' ? 'background' : kind,
      alive: pid !== null,
      pid,
      name: nonEmpty(agent.name) ?? previous?.name ?? null,
      status: nonEmpty(agent.status),
      state: nonEmpty(agent.state) ?? previous?.state ?? null,
      detail: previous?.detail ?? null,
      cwd: nonEmpty(agent.cwd) ?? previous?.cwd ?? null,
      updatedAt: previous?.updatedAt ?? null,
    });
  }

  return bySession;
}

function sameInfo(a: LiveSessionInfo | undefined, b: LiveSessionInfo | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.alive === b.alive
    && a.pid === b.pid
    && a.name === b.name
    && a.status === b.status
    && a.state === b.state
    && a.detail === b.detail
    && a.jobId === b.jobId;
}

type ChangeListener = (providerSessionIds: string[]) => void;

// A job counts as deleted only after this many consecutive complete reads
// without it, and never when too many vanish at once (a broken read).
const DELETED_AFTER_MISSES = 2;
const MAX_DELETIONS_PER_REFRESH = 5;

/** Where the ids of conversations that have been daemon jobs are kept across restarts. */
function knownJobsFile(): string {
  const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
  return path.join(path.dirname(databasePath), 'live-known-jobs.json');
}

class LiveSessionsService {
  private sessions = new Map<string, LiveSessionInfo>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private listeners = new Set<ChangeListener>();
  private deletionListeners = new Set<ChangeListener>();
  private knownJobs: Set<string> | null = null;
  private misses = new Map<string, number>();

  get(providerSessionId: string | null | undefined): LiveSessionInfo | null {
    if (!providerSessionId) {
      return null;
    }
    return this.sessions.get(providerSessionId) ?? null;
  }

  list(): Array<LiveSessionInfo & { sessionId: string }> {
    return [...this.sessions.entries()].map(([sessionId, info]) => ({ sessionId, ...info }));
  }

  private frozenForTests = false;

  /** @internal tests set the known sessions without running the CLI; an empty map unfreezes. */
  setForTests(entries: Map<string, LiveSessionInfo>): void {
    this.sessions = new Map(entries);
    this.frozenForTests = entries.size > 0;
    this.knownJobs = null;
    this.misses.clear();
  }

  /** Called with the provider ids of jobs deleted in Claude Code (Ctrl+X, `claude rm`). */
  onJobsDeleted(listener: ChangeListener): () => void {
    this.deletionListeners.add(listener);
    return () => this.deletionListeners.delete(listener);
  }

  private async loadKnownJobs(): Promise<Set<string>> {
    if (!this.knownJobs) {
      try {
        const raw = JSON.parse(await fs.readFile(knownJobsFile(), 'utf8')) as unknown;
        this.knownJobs = new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []);
      } catch {
        this.knownJobs = new Set();
      }
    }
    return this.knownJobs;
  }

  private async saveKnownJobs(): Promise<void> {
    if (!this.knownJobs) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(knownJobsFile()), { recursive: true });
      await fs.writeFile(knownJobsFile(), JSON.stringify([...this.knownJobs]), 'utf8');
    } catch (error) {
      console.warn('[live-sessions] could not save known jobs:', error);
    }
  }

  /** Remembers every job seen, and reports the ones that disappeared from Claude Code. */
  private async trackDeletedJobs(next: Map<string, LiveSessionInfo>): Promise<string[]> {
    const known = await this.loadKnownJobs();
    let dirty = false;
    for (const [sessionId, info] of next) {
      if (info.kind === 'background' && !known.has(sessionId)) {
        known.add(sessionId);
        dirty = true;
      }
    }

    const missing = [...known].filter((sessionId) => !next.has(sessionId));
    for (const sessionId of [...this.misses.keys()]) {
      if (!missing.includes(sessionId)) {
        this.misses.delete(sessionId);
      }
    }
    const deleted: string[] = [];
    for (const sessionId of missing) {
      const count = (this.misses.get(sessionId) ?? 0) + 1;
      this.misses.set(sessionId, count);
      if (count >= DELETED_AFTER_MISSES) {
        deleted.push(sessionId);
      }
    }

    if (deleted.length > MAX_DELETIONS_PER_REFRESH) {
      console.warn(`[live-sessions] ${deleted.length} jobs vanished at once; not treating them as deleted`);
      if (dirty) {
        await this.saveKnownJobs();
      }
      return [];
    }
    for (const sessionId of deleted) {
      known.delete(sessionId);
      this.misses.delete(sessionId);
      dirty = true;
    }
    if (dirty) {
      await this.saveKnownJobs();
    }
    return deleted;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads both sources now; concurrent callers share one refresh. */
  refresh(): Promise<void> {
    if (this.frozenForTests) {
      return Promise.resolve();
    }
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const [agents, jobs] = await Promise.all([readAgentsJson(), readJobStates()]);
    if (agents === null || jobs === null) {
      // Keep the last known state rather than reporting everything as gone.
      return;
    }
    await this.applySources(agents, jobs);
  }

  /** @internal Processes one complete read of both sources; the tests feed it directly. */
  async applySources(agents: AgentsJsonEntry[], jobs: JobStateFile[]): Promise<void> {
    const next = mergeLiveSources(agents, jobs);
    const deletedJobs = await this.trackDeletedJobs(next);

    const changed: string[] = [];
    for (const [sessionId, info] of next) {
      if (!sameInfo(this.sessions.get(sessionId), info)) {
        changed.push(sessionId);
      }
    }
    for (const sessionId of this.sessions.keys()) {
      if (!next.has(sessionId)) {
        changed.push(sessionId);
      }
    }

    this.sessions = next;
    if (deletedJobs.length > 0) {
      for (const listener of this.deletionListeners) {
        try {
          listener(deletedJobs);
        } catch (error) {
          console.warn('[live-sessions] deletion listener failed:', error);
        }
      }
    }
    if (changed.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(changed);
        } catch (error) {
          console.warn('[live-sessions] change listener failed:', error);
        }
      }
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Used by the websocket module (route turns, shell attach, session_upserted
 * payloads), the projects module (session summaries) and server startup
 * (polling and change broadcasts).
 */
export const liveSessionsService = new LiveSessionsService();
