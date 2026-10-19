import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { ProjectSortOrder } from '@/shared/types';
import { subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';
import { readProjectSortOrder, readSessionSortOrder } from '@/modules/sidebar/utils/sidebarStoredPreferences';

type SidebarSortMenuProps = {
  /** Button look: the desktop header's ghost icon or the mobile header's tile. */
  variant: 'desktop' | 'mobile';
};

const OPTIONS: { value: ProjectSortOrder; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Most recent' },
];

/**
 * CloudCLI live: one menu in the sidebar header to sort projects and the
 * conversations inside each project, by name or by most recent activity.
 * Both choices are user preferences, so they follow the user across devices.
 */
export default function SidebarSortMenu({ variant }: SidebarSortMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [projectOrder, setProjectOrder] = useState<ProjectSortOrder>(readProjectSortOrder);
  const [sessionOrder, setSessionOrder] = useState<ProjectSortOrder>(readSessionSortOrder);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribeToUserPreferences(() => {
    setProjectOrder(readProjectSortOrder());
    setSessionOrder(readSessionSortOrder());
  }), []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  const group = (
    title: string,
    current: ProjectSortOrder,
    key: 'projectSortOrder' | 'sessionSortOrder',
  ) => (
    <div role="group" aria-label={title} className="py-1">
      <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          aria-checked={current === option.value}
          onClick={() => writeUserPreference(key, option.value)}
          className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm text-foreground transition-colors hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none"
        >
          <Check className={cn('h-3.5 w-3.5 flex-shrink-0', current === option.value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
          {option.label}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="Sort"
        aria-label="Sort projects and conversations"
        className={variant === 'desktop'
          ? 'flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground'
          : 'flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95'}
      >
        <ArrowUpDown className={variant === 'desktop' ? 'h-3.5 w-3.5' : 'h-4 w-4 text-muted-foreground'} />
      </button>
      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-48 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg"
        >
          {group('Projects', projectOrder, 'projectSortOrder')}
          {group('Conversations', sessionOrder, 'sessionSortOrder')}
        </div>
      )}
    </div>
  );
}
