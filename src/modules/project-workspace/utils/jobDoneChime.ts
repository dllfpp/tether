/**
 * CloudCLI live: a small bell when a chat's background job stops working.
 * The tone is synthesized (Web Audio), so no sound file ships with the app.
 */

let audioContext: AudioContext | null = null;
// The last known state of each session's job, to see the working -> done edge.
const lastJobState = new Map<string, string>();

const WORKING_STATES = new Set(['working', 'running']);

// Browsers start audio only after a user gesture: the context is created (and
// resumed) on the first tap or key press, then reused.
function unlockAudio() {
  const Context = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return;
  audioContext ??= new Context();
  void audioContext.resume().catch(() => undefined);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAudio, { capture: true });
}

function ringBell() {
  const context = audioContext;
  if (!context || context.state !== 'running') return;
  const now = context.currentTime;
  // Two partials of a small bell, fading out over about a second and a half.
  for (const [frequency, gainPeak] of [[1318.5, 0.18], [2637, 0.06]] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 1.6);
  }
}

/**
 * Used by the project workspace's session-upsert handler: records a session's
 * job state and rings once when it leaves "working". The first state seen for
 * a session only records it, so a page load never rings for old jobs.
 */
export function noteJobState(sessionId: string, state: string | null | undefined) {
  if (!state) return;
  const previous = lastJobState.get(sessionId);
  lastJobState.set(sessionId, state);
  if (previous && WORKING_STATES.has(previous) && !WORKING_STATES.has(state)) {
    ringBell();
  }
}
