import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { QueuedDraft } from '@/shared/types';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';

type QueuedMessageListProps = {
  drafts: QueuedDraft[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onSendNow: (id: string) => void;
  /** Called with every id in the new order once a drag (or arrow key) ends. */
  onReorder: (orderedIds: string[]) => void;
};

type DragState = {
  id: string;
  fromIndex: number;
  startY: number;
  dy: number;
  /** Height of the dragged card plus the gap: how far the others move aside. */
  step: number;
  /** Vertical centre of every card when the drag started, in list order. */
  centres: number[];
};

const GAP_PX = 6;

const moveItem = (ids: string[], from: number, to: number): string[] => {
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/**
 * CloudCLI live: rendered by chat's ChatComposer above the input. The
 * session's queued messages, sent one per turn from the top. With more than
 * one, each card has a handle to drag it (mouse or finger: pointer events,
 * since HTML drag and drop does nothing on a phone) or to move it with the
 * arrow keys.
 */
export default function QueuedMessageList({ drafts, onEdit, onDelete, onSendNow, onReorder }: QueuedMessageListProps) {
  const { t } = useTranslation('chat');
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const ids = drafts.map((draft, index) => draft.id ?? `index-${index}`);
  const canReorder = drafts.length > 1;

  const targetIndex = (state: DragState): number => {
    const centre = state.centres[state.fromIndex] + state.dy;
    return state.centres.filter((other, index) => index !== state.fromIndex && other < centre).length;
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>, id: string, fromIndex: number) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const centres = ids.map((itemId) => {
      const rect = cardRefs.current.get(itemId)?.getBoundingClientRect();
      return rect ? rect.top + rect.height / 2 : 0;
    });
    const height = cardRefs.current.get(id)?.getBoundingClientRect().height ?? 0;
    setDrag({ id, fromIndex, startY: event.clientY, dy: 0, step: height + GAP_PX, centres });
  };

  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    setDrag((current) => (current ? { ...current, dy: event.clientY - current.startY } : current));
  };

  const endDrag = () => {
    if (!drag) {
      return;
    }
    const to = targetIndex(drag);
    setDrag(null);
    if (to !== drag.fromIndex) {
      onReorder(moveItem(ids, drag.fromIndex, to));
    }
  };

  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : index;
    if (to === index || to < 0 || to >= ids.length) {
      return;
    }
    event.preventDefault();
    onReorder(moveItem(ids, index, to));
  };

  /** How far a card is moved while another one is dragged past it. */
  const shiftFor = (index: number): number => {
    if (!drag || index === drag.fromIndex) {
      return 0;
    }
    const to = targetIndex(drag);
    if (drag.fromIndex < to && index > drag.fromIndex && index <= to) {
      return -drag.step;
    }
    if (drag.fromIndex > to && index >= to && index < drag.fromIndex) {
      return drag.step;
    }
    return 0;
  };

  return (
    <div className="settings-content-enter mb-2 chat-col flex flex-col" style={{ gap: GAP_PX }}>
      {drafts.map((draft, index) => {
        const id = ids[index];
        const isDragging = drag?.id === id;
        const offset = isDragging ? drag.dy : shiftFor(index);
        return (
          <div
            key={id}
            ref={(element) => {
              if (element) cardRefs.current.set(id, element);
              else cardRefs.current.delete(id);
            }}
            style={{
              transform: offset ? `translateY(${offset}px)` : undefined,
              transition: isDragging ? 'none' : 'transform 150ms ease',
            }}
          >
            <QueuedMessageCard
              content={draft.content}
              attachmentCount={draft.uploadedAttachments?.length ?? draft.attachments.length}
              position={index + 1}
              isDragging={isDragging}
              onEdit={() => onEdit(id)}
              onDelete={() => onDelete(id)}
              onSendNow={() => onSendNow(id)}
              handle={canReorder ? (
                <button
                  type="button"
                  onPointerDown={(event) => startDrag(event, id, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(event) => moveWithKeys(event, index)}
                  aria-label={t('input.queue.reorder', { defaultValue: 'Drag to change the order (or use the arrow keys)' })}
                  title={t('input.queue.reorder', { defaultValue: 'Drag to change the order (or use the arrow keys)' })}
                  className="-my-0.5 -ml-1 flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground active:cursor-grabbing"
                >
                  <GripVertical className="h-4 w-4" />
                </button>
              ) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
