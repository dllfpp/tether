import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, CircleStop, Loader2, XCircle } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import type { BackgroundTaskStatus, ChatMessage } from '@/shared/types';

type ChatSubagentMenuProps = {
  /** The loaded rows of the session; an agent on a page not loaded yet is not listed. */
  messages: ChatMessage[];
  /** Brings an agent's card into view. */
  onReveal: (message: ChatMessage) => void;
  /** Older pages of the conversation exist that are not loaded yet. */
  hasOlderMessages: boolean;
  /** Loads the whole conversation, so the agents of older pages are listed too. */
  onLoadAll: () => void;
};

const STATUS_ICONS: Record<BackgroundTaskStatus, typeof Bot> = {
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  stopped: CircleStop,
};

/**
 * CloudCLI live: rendered by chat's ChatMessagesPane in the workspace header.
 * Lists every agent the conversation spawned, newest first, with its state;
 * picking one scrolls to its card.
 */
export default function ChatSubagentMenu({ messages, onReveal, hasOlderMessages, onLoadAll }: ChatSubagentMenuProps) {
  const { t } = useTranslation('chat');
  const agents = useMemo(
    () => messages.filter((message) => message.isSubagentContainer && message.subagent).reverse(),
    [messages],
  );

  // A long chat may have agents only on pages not loaded yet: offer the
  // menu whenever there could be some.
  if (agents.length === 0 && !hasOlderMessages) {
    return null;
  }

  const running = agents.filter((message) => message.subagent?.status === 'running').length;
  const label = t('subagents.trigger', { count: agents.length, defaultValue: 'Subagents ({{count}})' });

  return (
    <ActionMenu
      icon={running > 0 ? Loader2 : Bot}
      label={hasOlderMessages ? `${agents.length}+` : String(agents.length)}
      // Opening the list loads the older pages, which adds their agents to it.
      onOpenChange={(open) => { if (open && hasOlderMessages) onLoadAll(); }}
      ariaLabel={label}
      // Rendered on the page, above the transcript: inside the header it was
      // drawn under the messages.
      portal
      triggerClassName="h-8 gap-1 rounded-lg border border-border/50 px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      menuClassName="max-h-[60vh] w-[300px] overflow-y-auto rounded-xl p-1.5 shadow-xl"
      header={(
        <div className="mb-1 border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-foreground">{label}</p>
        </div>
      )}
      items={[
        ...(hasOlderMessages ? [{
          key: 'loading-older',
          label: t('subagents.loadingOlder', { defaultValue: 'Loading older history…' }),
          icon: Loader2,
          disabled: true,
          onSelect: () => undefined,
        }] : []),
        ...agents.map((message, index) => {
        const subagent = message.subagent!;
        const status = t(`subagents.status.${subagent.status}`, { defaultValue: subagent.status });
        return {
          key: message.toolId ?? `${subagent.id}-${index}`,
          label: subagent.description || subagent.name || subagent.type || t('subagents.untitled', { defaultValue: 'Agent' }),
          description: [subagent.type, status].filter(Boolean).join(' · '),
          icon: STATUS_ICONS[subagent.status] ?? Bot,
          onSelect: () => onReveal(message),
        };
      })]}
    />
  );
}
