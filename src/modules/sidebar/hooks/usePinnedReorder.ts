import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';

import { api } from '@/shared/api';
import type { SessionWithProvider } from '@/shared/types';

type DragState = {
  id: string;
  fromIndex: number;
  startY: number;
  dy: number;
  /** Height of the dragged row: how far the others move aside. */
  step: number;
  /** Vertical centre of every pinned row when the drag started, in order. */
  centres: number[];
};

/** A press that may become a drag: mouse after a few pixels, touch after a hold. */
type Press = {
  id: string;
  pointerId: number;
  startY: number;
  touch: boolean;
  timer: number | null;
};

const moveItem = (ids: string[], from: number, to: number): string[] => {
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

/** How long a dropped order is shown before the server's own order takes over. */
const LOCAL_ORDER_TTL_MS = 5_000;
/** Mouse: moving this far with the button down starts a drag; less is a click. */
const MOUSE_DRAG_PX = 6;
/** Touch: holding this long starts a drag; moving first is a scroll. */
const TOUCH_HOLD_MS = 450;
const TOUCH_SLOP_PX = 8;

/**
 * CloudCLI live: used by the sidebar's SidebarProjectSessions to drag its
 * pinned conversations into a new order by the whole row. A click (or tap)
 * still opens the chat: a mouse drag starts after a few pixels, a touch drag
 * after a short hold (a quick swipe scrolls the list). Alt+arrow keys move the
 * focused row. The order is sent to the server, whose upserts move the rows on
 * every client; until they arrive the dropped order is shown.
 */
export function usePinnedReorder(sessions: SessionWithProvider[]) {
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pressRef = useRef<Press | null>(null);
  // The click that ends a drag must not open the chat.
  const suppressClickRef = useRef(false);
  const [localOrder, setLocalOrder] = useState<{ ids: string[]; at: number } | null>(null);

  const serverPinnedIds = useMemo(
    () => sessions.filter((session) => session.pinned).map((session) => session.id),
    [sessions],
  );

  useEffect(() => {
    if (!localOrder) return undefined;
    if (localOrder.ids.join('|') === serverPinnedIds.join('|')) {
      setLocalOrder(null);
      return undefined;
    }
    const timer = window.setTimeout(() => setLocalOrder(null), LOCAL_ORDER_TTL_MS - (Date.now() - localOrder.at));
    return () => window.clearTimeout(timer);
  }, [localOrder, serverPinnedIds]);

  const ordered = useMemo(() => {
    if (!localOrder) return sessions;
    const rank = new Map(localOrder.ids.map((id, index) => [id, index]));
    const pinned = sessions.filter((session) => session.pinned)
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return [...pinned, ...sessions.filter((session) => !session.pinned)];
  }, [localOrder, sessions]);

  const pinnedIds = useMemo(
    () => ordered.filter((session) => session.pinned).map((session) => session.id),
    [ordered],
  );
  const canReorder = pinnedIds.length > 1;

  const commit = useCallback((ids: string[]) => {
    setLocalOrder({ ids, at: Date.now() });
    void api.setPinnedOrder(ids).catch((error: unknown) => {
      console.error('Could not reorder the pinned conversations:', error);
      setLocalOrder(null);
    });
  }, []);

  const updateDrag = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const targetIndex = (state: DragState): number => {
    const centre = state.centres[state.fromIndex] + state.dy;
    return state.centres.filter((other, index) => index !== state.fromIndex && other < centre).length;
  };

  const beginDrag = (id: string, startY: number) => {
    const centres = pinnedIds.map((itemId) => {
      const rect = rowRefs.current.get(itemId)?.getBoundingClientRect();
      return rect ? rect.top + rect.height / 2 : 0;
    });
    const height = rowRefs.current.get(id)?.getBoundingClientRect().height ?? 0;
    updateDrag({ id, fromIndex: pinnedIds.indexOf(id), startY, dy: 0, step: height, centres });
    navigator.vibrate?.(10);
  };

  const finishDrag = () => {
    const current = dragRef.current;
    updateDrag(null);
    if (!current) return;
    suppressClickRef.current = true;
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    const to = targetIndex(current);
    if (to !== current.fromIndex) commit(moveItem(pinnedIds, current.fromIndex, to));
  };

  const clearPress = () => {
    const press = pressRef.current;
    if (press?.timer) window.clearTimeout(press.timer);
    pressRef.current = null;
  };

  // While a touch drag is on, the page must not scroll under the finger:
  // a non-passive touchmove listener is the one thing iOS honours mid-gesture.
  useEffect(() => {
    if (!drag) return undefined;
    const block = (event: TouchEvent) => event.preventDefault();
    document.addEventListener('touchmove', block, { passive: false });
    return () => document.removeEventListener('touchmove', block);
  }, [drag]);

  const rowProps = (id: string) => {
    if (!canReorder || !pinnedIds.includes(id)) return {};
    return {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        clearPress();
        const touch = event.pointerType !== 'mouse';
        const press: Press = { id, pointerId: event.pointerId, startY: event.clientY, touch, timer: null };
        if (touch) {
          press.timer = window.setTimeout(() => {
            if (pressRef.current === press) beginDrag(id, press.startY);
          }, TOUCH_HOLD_MS);
        }
        pressRef.current = press;
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const press = pressRef.current;
        const current = dragRef.current;
        if (current) {
          updateDrag({ ...current, dy: event.clientY - current.startY });
          return;
        }
        if (!press || press.pointerId !== event.pointerId) return;
        const moved = Math.abs(event.clientY - press.startY);
        if (press.touch) {
          // Moving before the hold is a scroll.
          if (moved > TOUCH_SLOP_PX) clearPress();
        } else if (moved > MOUSE_DRAG_PX) {
          event.currentTarget.setPointerCapture(event.pointerId);
          beginDrag(id, press.startY);
          updateDrag({ ...dragRef.current!, dy: event.clientY - press.startY });
        }
      },
      onPointerUp: () => {
        clearPress();
        finishDrag();
      },
      onPointerCancel: () => {
        clearPress();
        // iOS cancels the pointer when it takes the gesture; a drag already on ends here.
        finishDrag();
      },
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      // A held press on a phone opens no context menu; a link is not dragged natively.
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        if (pressRef.current?.touch || dragRef.current) event.preventDefault();
      },
      onDragStart: (event: { preventDefault: () => void }) => event.preventDefault(),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!event.altKey) return;
        const index = pinnedIds.indexOf(id);
        const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : index;
        if (to === index || to < 0 || to >= pinnedIds.length) return;
        event.preventDefault();
        commit(moveItem(pinnedIds, index, to));
      },
    };
  };

  /** How far a pinned row is moved while the drag is on. */
  const offsetFor = (id: string): number => {
    if (!drag) return 0;
    const index = pinnedIds.indexOf(id);
    if (index < 0) return 0;
    if (id === drag.id) return drag.dy;
    const to = targetIndex(drag);
    if (drag.fromIndex < to && index > drag.fromIndex && index <= to) return -drag.step;
    if (drag.fromIndex > to && index >= to && index < drag.fromIndex) return drag.step;
    return 0;
  };

  const rowRef = (id: string) => (element: HTMLElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  };

  return { ordered, canReorder, rowProps, offsetFor, rowRef, draggingId: drag?.id ?? null };
}
