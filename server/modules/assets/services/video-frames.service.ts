import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/image-attachments.js';

const execFileAsync = promisify(execFile);

/** Largest video accepted as a chat attachment (other files stay at 10MB). */
export const MAX_VIDEO_ATTACHMENT_BYTES = 200 * 1024 * 1024;
export const MAX_OTHER_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// The contact sheet: COLUMNS x ROWS frames spread evenly over the video.
const COLUMNS = 6;
const ROWS = 5;
const FRAME_WIDTH_PX = 320;
const FFMPEG_TIMEOUT_MS = 90_000;

type StoredFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type FramesRecord = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
};

/** Whether one upload is a video, by mime type or by extension (iOS sends both). */
export function isVideoUpload(file: Pick<StoredFile, 'mimetype' | 'originalname'>): boolean {
  return file.mimetype.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(file.originalname);
}

async function readDurationSeconds(videoPath: string): Promise<number | null> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath,
  ], { timeout: FFMPEG_TIMEOUT_MS });
  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * Builds a JPEG contact sheet of an uploaded video next to it in the assets
 * folder, so a provider that reads images (not video) can see what it shows.
 * Returns null when ffmpeg is missing or the video cannot be decoded: the
 * video itself is still attached.
 */
export async function buildVideoContactSheet(file: StoredFile): Promise<FramesRecord | null> {
  const assetsDir = getGlobalImageAssetsDir();
  const videoPath = path.join(assetsDir, file.filename);
  const sheetName = `${file.filename}.frames.jpg`;
  const sheetPath = path.join(assetsDir, sheetName);

  try {
    const duration = await readDurationSeconds(videoPath);
    if (!duration) return null;
    const fps = (COLUMNS * ROWS) / duration;
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-i', videoPath,
      '-vf', `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH_PX}:-2,tile=${COLUMNS}x${ROWS}`,
      '-frames:v', '1', '-q:v', '4', sheetPath,
    ], { timeout: FFMPEG_TIMEOUT_MS });
    const stat = await fs.stat(sheetPath);
    return {
      name: `${file.originalname} (frames, ${COLUMNS * ROWS} over ${duration.toFixed(1)}s, left to right then down).jpg`,
      path: toPosixPath(sheetPath),
      size: stat.size,
      mimeType: 'image/jpeg',
    };
  } catch (error) {
    console.warn(`[assets] contact sheet failed for ${file.originalname}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
