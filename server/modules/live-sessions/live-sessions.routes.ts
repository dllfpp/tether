import { appendFile } from 'node:fs/promises';

import express from 'express';
import type { Request, Response } from 'express';

import { answerJobQuestion, startJobInProject, stopJobForSession } from '@/modules/live-sessions/services/live-inject.service.js';
import { liveSessionsService } from '@/modules/live-sessions/services/live-sessions.service.js';
import { peekSuggestionForSession } from '@/modules/live-sessions/services/prompt-suggestion.service.js';
import { moveSessionToProject } from '@/modules/live-sessions/services/session-move.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  if (value.length > maxLength) {
    throw new AppError(`${field} is too long.`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value;
}

const router = express.Router();

// TEMP blank-chat debug: snapshots of the chat area sent by every client.
router.post(
  '/client-debug',
  asyncHandler(async (req: Request, res: Response) => {
    await appendFile('/tmp/tether-client-debug.log', `${JSON.stringify(req.body ?? null).slice(0, 50_000)}\n`);
    res.json(createApiSuccessResponse({ ok: true }));
  }),
);

/** Live state of every known Claude Code conversation, keyed by provider session id. */
router.get(
  '/sessions',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse(liveSessionsService.list()));
  }),
);

/** Starts a new background job in one of the app's projects. */
router.post(
  '/jobs',
  asyncHandler(async (req: Request, res: Response) => {
    const jobId = await startJobInProject({
      projectPath: readString(req.body?.projectPath, 'projectPath', 4096),
      prompt: readString(req.body?.prompt, 'prompt', 100_000),
      name: typeof req.body?.name === 'string' ? req.body.name : null,
    });
    res.json(createApiSuccessResponse({ jobId }));
  }),
);

/** The suggested next prompt for a conversation (grey text in the composer), or null. */
router.get(
  '/sessions/:sessionId/suggestion',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await peekSuggestionForSession(readString(req.params.sessionId, 'sessionId', 200));
    res.json(createApiSuccessResponse(result));
  }),
);

/** Stops the daemon job behind an app session. The conversation is kept. */
router.post(
  '/sessions/:sessionId/stop',
  asyncHandler(async (req: Request, res: Response) => {
    await stopJobForSession(readString(req.params.sessionId, 'sessionId', 200));
    res.json(createApiSuccessResponse({ stopped: true }));
  }),
);

/**
 * Answers the question (AskUserQuestion) the daemon job behind an app session
 * is waiting on. Body: the tool's `questions` and the panel's `answers`.
 */
router.post(
  '/sessions/:sessionId/answer',
  asyncHandler(async (req: Request, res: Response) => {
    const questions: unknown = req.body?.questions;
    const answers: unknown = req.body?.answers;
    if (
      !Array.isArray(questions) || questions.length === 0 || questions.length > 8
      || questions.some((question) => typeof question?.question !== 'string')
      || typeof answers !== 'object' || answers === null || Array.isArray(answers)
      || Object.values(answers).some((value) => typeof value !== 'string' || value.length > 2_000)
    ) {
      throw new AppError('questions and answers are required.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    await answerJobQuestion({
      sessionId: readString(req.params.sessionId, 'sessionId', 200),
      questions,
      answers: answers as Record<string, string>,
    });
    res.json(createApiSuccessResponse({ answered: true }));
  }),
);

/**
 * Moves a conversation into another project (an existing one by path, or a
 * new folder named by the user), in Claude Code itself.
 */
router.post(
  '/sessions/:sessionId/move',
  asyncHandler(async (req: Request, res: Response) => {
    const projectPath = typeof req.body?.projectPath === 'string' ? req.body.projectPath.slice(0, 4096) : null;
    const newProjectName = typeof req.body?.newProjectName === 'string' ? req.body.newProjectName.slice(0, 64) : null;
    const result = await moveSessionToProject({
      sessionId: readString(req.params.sessionId, 'sessionId', 200),
      projectPath,
      newProjectName,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/** Mounted by server startup under /api/live, behind authentication. */
export default router;
