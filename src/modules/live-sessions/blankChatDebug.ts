// TEMP blank-chat debug, always on: when the app loads or comes back to the
// foreground, records what the chat area actually contains (sizes, messages,
// composer) a few times in a row and posts it to the server. Remove once the
// blank conversation after a resume on iOS is understood.
import { authenticatedFetch } from '@/shared/api';

function rect(selector: string) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
    display: style.display, visibility: style.visibility, opacity: style.opacity,
    scrollTop: Math.round((el as HTMLElement).scrollTop), scrollHeight: (el as HTMLElement).scrollHeight,
    children: el.children.length,
  };
}

function snapshot(why: string, step: number) {
  return {
    at: new Date().toISOString(),
    why,
    step,
    path: location.pathname,
    visibility: document.visibilityState,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    viewport: { w: window.innerWidth, h: window.innerHeight, vv: Math.round(window.visualViewport?.height ?? 0) },
    pane: rect('.chat-messages-pane'),
    messages: document.querySelectorAll('.chat-message').length,
    composer: rect('[data-slot="prompt-input"]'),
    textarea: Boolean(document.querySelector('[data-slot="prompt-input-textarea"]')),
    errorBoundary: Boolean(document.querySelector('[role="alert"]')),
    loadingText: document.querySelector('.chat-messages-pane')?.textContent?.slice(0, 120) ?? null,
    domNodes: document.getElementsByTagName('*').length,
  };
}

export function installBlankChatDebug(): void {
  const send = (entries: unknown[]) => {
    void authenticatedFetch('/api/live/client-debug', { method: 'POST', body: JSON.stringify({ entries }) })
      .catch(() => undefined);
  };
  const probe = (why: string) => {
    const entries: unknown[] = [];
    // Right away, then as the reconnect and the transcript reload settle.
    [0, 1500, 5000, 12000].forEach((delay, step) => {
      window.setTimeout(() => {
        entries.push(snapshot(why, step));
        if (step === 3) send(entries);
      }, delay);
    });
  };
  // Lifecycle diary kept on the device (no network needed): when this page
  // went to the background, came back, and a heartbeat every 2 s while it is
  // visible. The next load sends the previous page's diary, which tells a
  // page iOS discarded in the background (nothing after the last "hidden")
  // from one that came back but drew nothing (visible + heartbeats after it).
  const DIARY_KEY = 'tether-lifecycle-diary';
  const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let previous: unknown = null;
  try {
    previous = JSON.parse(localStorage.getItem(DIARY_KEY) ?? 'null');
  } catch {
    previous = null;
  }
  const diary = { pageId, loadedAt: new Date().toISOString(), events: [] as Array<[string, string]>, lastBeatAt: null as string | null };
  const save = () => {
    try {
      localStorage.setItem(DIARY_KEY, JSON.stringify(diary));
    } catch {
      // storage full or unavailable: the diary is best effort
    }
  };
  const note = (event: string) => {
    diary.events.push([event, new Date().toISOString()]);
    if (diary.events.length > 40) diary.events.splice(0, diary.events.length - 40);
    save();
  };
  note('load');
  window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      diary.lastBeatAt = new Date().toISOString();
      save();
    }
  }, 2_000);

  send([{ at: new Date().toISOString(), why: 'previous-page-diary', previous, viewport: { w: window.innerWidth, h: window.innerHeight } }]);
  probe('load');
  document.addEventListener('visibilitychange', () => {
    note(document.visibilityState);
    if (document.visibilityState === 'visible') probe('resume');
  });
  window.addEventListener('pageshow', (event) => {
    note(event.persisted ? 'pageshow-bfcache' : 'pageshow');
    if (event.persisted) probe('pageshow');
  });
  window.addEventListener('pagehide', (event) => note(event.persisted ? 'pagehide-bfcache' : 'pagehide'));
  document.addEventListener('freeze', () => note('freeze'));
  document.addEventListener('resume', () => note('resume-event'));
}
