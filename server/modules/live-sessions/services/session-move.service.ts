import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { stopJobForSession } from '@/modules/live-sessions/services/live-inject.service.js';
import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

/**
 * CloudCLI live: moves a Claude Code conversation into another project, for
 * real, the way it was done by hand when the root project was sorted by topic:
 * the transcript (and its `<id>/` side folder) goes to the target project's
 * folder under ~/.claude/projects with every `cwd` rewritten, a daemon job's
 * own state follows, and only then are the originals removed. From the
 * terminal, `cd <project> && claude --resume` finds it there afterwards.
 */

const STOP_WAIT_MS = 20_000;
const SAFE_JOB_ID = /^[a-z0-9]{6,16}$/i;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

const claudeProjectsDir = () => path.join(os.homedir(), '.claude', 'projects');
/** Claude Code's own folder name for a working directory. */
export const encodeClaudeProjectPath = (projectPath: string) => projectPath.replace(/[^a-zA-Z0-9-]/g, '-');

const isProcessAlive = (pid: number | null | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** The transcript with each record's `cwd` moved; lines that are not JSON stay byte for byte. */
export function rewriteTranscriptCwd(content: string, fromCwd: string, toCwd: string): string {
  return content.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.cwd !== fromCwd) return line;
      return JSON.stringify({ ...record, cwd: toCwd });
    } catch {
      return line;
    }
  }).join('\n');
}

/** A new project's folder: `<home>/<name>`, the convention of the projects already there. */
export function newProjectPathFor(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, '-');
  if (!PROJECT_NAME.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new AppError('Use letters, digits, dots, dashes or underscores for the project name.', {
      code: 'INVALID_PROJECT_NAME',
      statusCode: 400,
    });
  }
  return path.join(os.homedir(), trimmed);
}

async function rewriteJobState(jobId: string, fromCwd: string, toCwd: string, fromJsonl: string, toJsonl: string): Promise<void> {
  const stateFile = path.join(os.homedir(), '.claude', 'jobs', jobId, 'state.json');
  if (!(await pathExists(stateFile))) return;
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
  if (state.cwd === fromCwd) state.cwd = toCwd;
  if (state.originCwd === fromCwd) state.originCwd = toCwd;
  if (state.linkScanPath === fromJsonl) {
    state.linkScanPath = toJsonl;
    // The scan offset counted bytes of the old file; the moved one is already read.
    state.linkScanOffset = (await fs.stat(toJsonl)).size;
  }
  const temporary = `${stateFile}.tether-move`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2));
  await fs.rename(temporary, stateFile);
}

export async function moveSessionToProject(input: {
  sessionId: string;
  projectPath?: string | null;
  newProjectName?: string | null;
}): Promise<{ projectId: string | null; projectPath: string; jsonlPath: string }> {
  const row = sessionsDb.getSessionById(input.sessionId);
  if (!row) {
    throw new AppError('The conversation no longer exists.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
  if (row.provider !== 'claude' || !row.jsonl_path || !row.project_path) {
    throw new AppError('Only Claude Code conversations with a transcript can be moved.', { code: 'NOT_MOVABLE', statusCode: 400 });
  }
  const fromCwd = row.project_path;
  const fromJsonl = row.jsonl_path;

  const toCwd = input.newProjectName
    ? newProjectPathFor(input.newProjectName)
    : normalizeProjectPath(input.projectPath ?? '');
  if (!toCwd) {
    throw new AppError('Choose a project or name a new one.', { code: 'MISSING_TARGET', statusCode: 400 });
  }
  if (toCwd === fromCwd) {
    throw new AppError('The conversation is already in that project.', { code: 'SAME_PROJECT', statusCode: 400 });
  }
  if (!input.newProjectName) {
    const target = projectsDb.getProjectPath(toCwd);
    if (!target || target.isArchived) {
      throw new AppError('That project does not exist.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
  }

  // Nothing may write to the transcript while it moves.
  const live = liveSessionsService.get(row.provider_session_id ?? row.session_id);
  if (live?.alive && live.kind === 'interactive') {
    throw new AppError('The conversation is open in a terminal; close it there first.', { code: 'SESSION_BUSY', statusCode: 409 });
  }
  if (live?.alive && (live.state === 'working' || live.state === 'blocked' || (!live.state && live.status === 'busy'))) {
    throw new AppError('Claude is still working in this conversation; move it when the turn is over.', { code: 'SESSION_BUSY', statusCode: 409 });
  }
  const jobId = live?.kind === 'background' && live.jobId && SAFE_JOB_ID.test(live.jobId) ? live.jobId : null;
  if (jobId && live?.alive) {
    await stopJobForSession(row.session_id);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (isProcessAlive(live.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (isProcessAlive(live.pid)) {
      throw new AppError('The job did not stop in time; try again in a moment.', { code: 'JOB_STILL_RUNNING', statusCode: 409 });
    }
  }

  const sourceDir = path.dirname(fromJsonl);
  const fileName = path.basename(fromJsonl);
  const sideFolder = path.join(sourceDir, fileName.replace(/\.jsonl$/, ''));
  const targetDir = path.join(claudeProjectsDir(), encodeClaudeProjectPath(toCwd));
  const toJsonl = path.join(targetDir, fileName);
  if (await pathExists(toJsonl)) {
    throw new AppError('A conversation with the same id is already in that project.', { code: 'TARGET_EXISTS', statusCode: 409 });
  }

  // A new project gets its folder and its row before anything moves.
  await fs.mkdir(toCwd, { recursive: true });
  let projectRow = projectsDb.getProjectPath(toCwd);
  if (!projectRow || projectRow.isArchived) {
    projectRow = projectsDb.createProjectPath(toCwd, input.newProjectName?.trim() || null).project;
  }

  // Copy, verify, repoint, and only then remove the originals.
  const original = await fs.readFile(fromJsonl, 'utf8');
  const moved = rewriteTranscriptCwd(original, fromCwd, toCwd);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(toJsonl, moved);
  if ((await fs.readFile(toJsonl, 'utf8')).split('\n').length !== original.split('\n').length) {
    await fs.rm(toJsonl, { force: true });
    throw new AppError('The moved transcript did not match the original; nothing was changed.', { code: 'MOVE_VERIFY_FAILED', statusCode: 500 });
  }
  const hasSideFolder = await pathExists(sideFolder);
  if (hasSideFolder) {
    await fs.cp(sideFolder, path.join(targetDir, path.basename(sideFolder)), { recursive: true });
  }
  if (jobId) {
    await rewriteJobState(jobId, fromCwd, toCwd, fromJsonl, toJsonl);
  }
  sessionsDb.moveSessionToProject(row.session_id, toCwd, toJsonl);

  await fs.rm(fromJsonl, { force: true });
  if (hasSideFolder) {
    await fs.rm(sideFolder, { recursive: true, force: true });
  }
  void liveSessionsService.refresh();

  return { projectId: projectRow?.project_id ?? null, projectPath: toCwd, jsonlPath: toJsonl };
}
