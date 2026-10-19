import type { TFunction } from 'i18next';

import type { LiveSessionInfo } from '@/shared/types';
import { cn } from '@/shared/utils';

type LiveTone = 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'terminal';

// Dot and label colors per tone. The label text always accompanies the color.
const LIVE_DOT_CLASS: Record<LiveTone, string> = {
  working: 'bg-blue-500',
  blocked: 'bg-amber-500',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  stopped: 'bg-muted-foreground/50',
  terminal: 'bg-violet-500',
};

const LIVE_TEXT_CLASS: Record<LiveTone, string> = {
  working: 'text-blue-700 dark:text-blue-300',
  blocked: 'text-amber-700 dark:text-amber-300',
  done: 'text-green-700 dark:text-green-300',
  failed: 'text-red-700 dark:text-red-300',
  stopped: 'text-muted-foreground',
  terminal: 'text-violet-700 dark:text-violet-300',
};

function getLiveStatus(live: LiveSessionInfo, t: TFunction): { tone: LiveTone; label: string; pulse: boolean } | null {
  if (live.kind === 'interactive') {
    return live.alive
      ? { tone: 'terminal', label: t('live.state.terminal', { defaultValue: 'Open in a terminal' }), pulse: false }
      : null;
  }

  const state = (live.state ?? '').toLowerCase();
  if (state === 'blocked' || state.includes('input')) {
    return { tone: 'blocked', label: t('live.state.blocked', { defaultValue: 'Waiting for you' }), pulse: true };
  }
  if (state === 'failed' || state === 'error') {
    return { tone: 'failed', label: t('live.state.failed', { defaultValue: 'Failed' }), pulse: false };
  }
  // The daemon's state wins over the process flag: a job that ended its turn
  // stays "busy" while a background command it started keeps running.
  if (live.alive && state === 'done') {
    return { tone: 'done', label: t('live.state.done', { defaultValue: 'Done' }), pulse: false };
  }
  if (live.alive && (state === 'working' || (!state && live.status === 'busy'))) {
    return { tone: 'working', label: t('live.state.working', { defaultValue: 'Working' }), pulse: true };
  }
  if (!live.alive) {
    return { tone: 'stopped', label: t('live.state.stopped', { defaultValue: 'Stopped' }), pulse: false };
  }
  return { tone: 'done', label: t('live.state.done', { defaultValue: 'Done' }), pulse: false };
}

/** Whether LiveStatusLine draws anything (an ended terminal session has no state). */
export const hasLiveStatus = (live: LiveSessionInfo | null | undefined): boolean => (
  Boolean(live) && (live!.kind !== 'interactive' || live!.alive)
);

type LiveStatusLineProps = {
  live: LiveSessionInfo | null | undefined;
  t: TFunction;
  /** Also show the job's own one-line status after the state label. */
  showDetail?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

/**
 * Used by the sidebar module (session rows) and the workspace title:
 * a colored dot plus a state label, optionally followed by the job's status
 * line, for a conversation owned by a Claude Code process.
 */
export default function LiveStatusLine({ live, t, showDetail = true, size = 'sm', className }: LiveStatusLineProps) {
  const status = live ? getLiveStatus(live, t) : null;
  if (!status) {
    return null;
  }

  const detail = showDetail ? live?.detail : null;

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 leading-tight', size === 'sm' ? 'text-[11px]' : 'text-xs', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex-shrink-0 rounded-full',
          size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
          LIVE_DOT_CLASS[status.tone],
          status.pulse && 'animate-pulse motion-reduce:animate-none',
        )}
      />
      <span className={cn('flex-shrink-0', size === 'sm' ? 'font-medium' : 'font-semibold', LIVE_TEXT_CLASS[status.tone])}>
        {status.label}
      </span>
      {detail && (
        <span className="min-w-0 truncate text-muted-foreground" title={detail}>
          · {detail}
        </span>
      )}
    </div>
  );
}
