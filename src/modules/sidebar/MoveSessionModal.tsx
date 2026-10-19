import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';
import { FolderInput, FolderPlus, Loader2, Search, X } from 'lucide-react';

import { api } from '@/shared/api';
import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import { getProjectLastActivity } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/** What the "…" menu of a conversation row hands over when "Move to project…" is picked. */
export type MoveSessionRequest = {
  sessionId: string;
  sessionName: string;
  projectId: string | null;
};

const MoveSessionContext = createContext<((request: MoveSessionRequest) => void) | null>(null);

/** Read by SessionOptions: null where no modal is mounted, which hides the menu item. */
export const useMoveSessionRequest = () => useContext(MoveSessionContext);

type MoveSessionProviderProps = {
  projects: Project[];
  /** Reloads the sidebar once the conversation sits in its new project. */
  onMoved: () => Promise<void> | void;
  children: ReactNode;
};

/**
 * CloudCLI live: mounted once by Sidebar. Rows ask for a move through the
 * context; the modal moves the conversation in Claude Code itself (the server
 * rewrites its transcript into the target project's folder).
 */
export function MoveSessionProvider({ projects, onMoved, children }: MoveSessionProviderProps) {
  const [request, setRequest] = useState<MoveSessionRequest | null>(null);
  return (
    <MoveSessionContext.Provider value={setRequest}>
      {children}
      {request && ReactDOM.createPortal(
        <MoveSessionModal
          key={request.sessionId}
          request={request}
          projects={projects}
          onClose={() => setRequest(null)}
          onMoved={onMoved}
        />,
        document.body,
      )}
    </MoveSessionContext.Provider>
  );
}

type SortOrder = 'name' | 'date';

function MoveSessionModal({ request, projects, onClose, onMoved }: {
  request: MoveSessionRequest;
  projects: Project[];
  onClose: () => void;
  onMoved: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [query, setQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('name');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (mode === 'existing' ? searchRef : nameRef).current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isMoving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isMoving, onClose]);

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = projects
      .filter((project) => project.projectId !== request.projectId)
      .filter((project) => {
        if (!needle) return true;
        const name = (project.displayName || '').toLowerCase();
        const projectPath = (project.fullPath || project.path || '').toLowerCase();
        return name.includes(needle) || projectPath.includes(needle);
      });
    return sortOrder === 'name'
      ? [...list].sort((a, b) => (a.displayName || a.projectId).localeCompare(b.displayName || b.projectId, undefined, { sensitivity: 'base' }))
      : [...list].sort((a, b) => getProjectLastActivity(b).getTime() - getProjectLastActivity(a).getTime());
  }, [projects, query, request.projectId, sortOrder]);

  const trimmedName = newName.trim().replace(/\s+/g, '-');
  const canSubmit = !isMoving && (mode === 'existing' ? Boolean(selectedPath) : trimmedName.length > 0);

  // The double-clicked row passes its path: state set on the same click is not read yet.
  const submit = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? selectedPath;
    if (isMoving || (mode === 'existing' ? !targetPath : !trimmedName)) return;
    setIsMoving(true);
    setError(null);
    try {
      const response = await api.moveSessionToProject(
        request.sessionId,
        mode === 'existing' ? { projectPath: targetPath ?? '' } : { newProjectName: newName.trim() },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
        setError(message ?? 'The conversation could not be moved.');
        return;
      }
      await onMoved();
      onClose();
    } catch {
      setError('The conversation could not be moved.');
    } finally {
      setIsMoving(false);
    }
  };

  const tabClass = (active: boolean) => cn(
    'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isMoving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-session-title"
        className="flex max-h-[min(85dvh,40rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-border p-5">
          <div className="min-w-0 flex-1">
            <h3 id="move-session-title" className="text-lg font-semibold text-foreground">Move to a project</h3>
            <p className="mt-1 truncate text-sm text-muted-foreground" title={request.sessionName}>{request.sessionName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isMoving}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-5 pb-3">
          <div className="flex rounded-lg bg-muted/60 p-1" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'existing'} className={tabClass(mode === 'existing')} onClick={() => setMode('existing')}>
              <FolderInput className="h-4 w-4" /> Add to a project
            </button>
            <button type="button" role="tab" aria-selected={mode === 'new'} className={tabClass(mode === 'new')} onClick={() => setMode('new')}>
              <FolderPlus className="h-4 w-4" /> Add to a new project
            </button>
          </div>

          {mode === 'existing' ? (
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search projects"
                  aria-label="Search projects"
                  className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:text-sm"
                />
              </div>
              <div className="flex flex-shrink-0 rounded-lg bg-muted/60 p-1 text-xs" role="group" aria-label="Sort projects">
                <button type="button" aria-pressed={sortOrder === 'name'} className={tabClass(sortOrder === 'name')} onClick={() => setSortOrder('name')}>A–Z</button>
                <button type="button" aria-pressed={sortOrder === 'date'} className={tabClass(sortOrder === 'date')} onClick={() => setSortOrder('date')}>Newest</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="move-session-new-project" className="text-sm text-foreground">Project name</label>
              <input
                id="move-session-new-project"
                ref={nameRef}
                type="text"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
                maxLength={64}
                placeholder="e.g. invoice-tool"
                autoComplete="off"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {trimmedName ? <>Creates the folder <code className="font-mono">~/{trimmedName}</code></> : 'A new folder in your home directory'}
              </p>
            </div>
          )}
        </div>

        {mode === 'existing' && (
          <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" role="listbox" aria-label="Projects">
            {candidates.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">No project matches.</li>
            ) : candidates.map((project) => {
              const projectPath = project.fullPath || project.path || '';
              const selected = projectPath === selectedPath;
              return (
                <li key={project.projectId} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(projectPath)}
                    onDoubleClick={() => { setSelectedPath(projectPath); void submit(projectPath); }}
                    className={cn(
                      'flex w-full min-w-0 flex-col rounded-lg px-3 py-2 text-left transition-colors',
                      selected ? 'bg-primary/15 ring-1 ring-primary/50' : 'hover:bg-accent',
                    )}
                  >
                    <span className="truncate text-sm font-medium text-foreground">{project.displayName || project.projectId}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{projectPath}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            The conversation moves in Claude Code too: from a terminal, resume it in the new folder. A finished
            background job is stopped first; one that is still working cannot be moved.
          </p>
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isMoving}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {isMoving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === 'existing' ? 'Move here' : 'Create and move'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
