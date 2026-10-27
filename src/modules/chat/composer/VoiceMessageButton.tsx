import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, Loader2, Lock, Mic, Send, Square, Trash2 } from 'lucide-react';

import { useVoiceMessage } from '@/modules/chat/hooks/useVoiceMessage';
import type { VoiceRecording } from '@/modules/chat/hooks/useVoiceMessage';
import { transcribeVoice } from '@/shared/api';
import type { VoiceInputState } from '@/shared/types';
import { cn } from '@/shared/utils';

type Props = {
  /** Dictation (a quick tap): its state and toggle, owned by the composer. */
  dictationState: VoiceInputState;
  onToggleDictation: () => void;
  /** Sends the recording with its transcript as the message text. */
  onSendVoice: (recording: File, transcript: string) => void;
  errorMsg?: string | null;
  onError: (message: string) => void;
};

type Phase = 'idle' | 'holding' | 'locked' | 'review' | 'sending';

/** A press shorter than this is a tap (dictation); longer records a voice message. */
const HOLD_MS = 280;
/** Sliding the finger up this far locks the recording; left this far cancels it. */
const LOCK_PX = 70;
const CANCEL_PX = 90;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * CloudCLI live: rendered by chat's ChatComposer in place of the dictation
 * button. Like a messaging app: hold to record and release to send; while
 * holding, slide up to lock (then stop, listen back, send or delete) or left
 * to cancel. A quick tap still starts dictation into the text box. The voice
 * message is transcribed on the server; the transcript is what the agent
 * reads, and the recording is attached so the chat can play it.
 */
export default function VoiceMessageButton({ dictationState, onToggleDictation, onSendVoice, errorMsg, onError }: Props) {
  const { t } = useTranslation('chat');
  const { recording, seconds, start, finish } = useVoiceMessage(onError);
  const [phase, setPhase] = useState<Phase>('idle');
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [review, setReview] = useState<VoiceRecording | null>(null);
  const pressRef = useRef<{ x: number; y: number; timer: number | null; holding: boolean } | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  useEffect(() => () => {
    if (review) URL.revokeObjectURL(review.url);
  }, [review]);

  const send = useCallback(async (voice: VoiceRecording) => {
    setPhase('sending');
    let transcript = '';
    try {
      const response = await transcribeVoice(voice.file, voice.file.name);
      if (response.ok) transcript = String((await response.json())?.text ?? '').trim();
    } catch {
      // Sent anyway: the recording is attached, the text says it was not transcribed.
    }
    onSendVoice(voice.file, transcript
      ? `🎤 ${transcript}`
      : `🎤 ${t('voiceMessage.untranscribed', { defaultValue: '(voice message, transcription not available)' })}`);
    setReview(null);
    setPhase('idle');
  }, [onSendVoice, t]);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (phase !== 'idle' || dictationState === 'transcribing') return;
    // Dictation in progress: a tap stops it, as before.
    if (dictationState === 'recording') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const press = { x: event.clientX, y: event.clientY, timer: null as number | null, holding: false };
    press.timer = window.setTimeout(() => {
      press.holding = true;
      setPhase('holding');
      setDrag({ dx: 0, dy: 0 });
      void start().then((started) => {
        if (!started && phaseRef.current === 'holding') setPhase('idle');
      });
    }, HOLD_MS);
    pressRef.current = press;
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (!press?.holding || phaseRef.current !== 'holding') return;
    const dx = Math.min(0, event.clientX - press.x);
    const dy = Math.min(0, event.clientY - press.y);
    setDrag({ dx, dy });
    if (-dy > LOCK_PX) {
      setPhase('locked');
      navigator.vibrate?.(10);
    } else if (-dx > CANCEL_PX) {
      pressRef.current = null;
      setPhase('idle');
      void finish('cancel');
    }
  };

  const onPointerUp = () => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) {
      if (dictationState === 'recording') onToggleDictation();
      return;
    }
    if (press.timer) window.clearTimeout(press.timer);
    if (!press.holding) {
      onToggleDictation();
      return;
    }
    if (phaseRef.current === 'holding') {
      void finish('keep').then((voice) => {
        if (voice) void send(voice);
        else setPhase('idle');
      });
    }
  };

  const stopLocked = () => {
    void finish('keep').then((voice) => {
      if (voice) {
        setReview(voice);
        setPhase('review');
      } else {
        setPhase('idle');
      }
    });
  };

  const discard = () => {
    if (phase === 'locked') void finish('cancel');
    setReview(null);
    setPhase('idle');
  };

  const dictationIcon = dictationState === 'recording'
    ? <Square className="h-4 w-4 text-red-500" />
    : dictationState === 'transcribing'
      ? <Loader2 className="h-4 w-4 animate-spin" />
      : <Mic className="h-4 w-4" />;

  // The bar over the composer while a voice message is recorded or reviewed.
  const bar = phase !== 'idle' && createPortal(
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 shadow-2xl backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        {phase === 'holding' && (
          <>
            <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden />
            <span className="w-12 font-mono text-sm tabular-nums text-foreground">{clock(seconds)}</span>
            <span
              className="flex flex-1 items-center justify-center gap-1 text-sm text-muted-foreground"
              style={{ transform: `translateX(${drag.dx / 2}px)`, opacity: 1 + drag.dx / (CANCEL_PX * 1.5) }}
            >
              <ChevronLeft className="h-4 w-4" />
              {t('voiceMessage.slideToCancel', { defaultValue: 'Slide left to cancel' })}
            </span>
            <span
              className="flex flex-col items-center text-xs text-muted-foreground"
              style={{ transform: `translateY(${Math.max(drag.dy, -LOCK_PX) / 2}px)` }}
            >
              <Lock className="h-4 w-4" />
              {t('voiceMessage.slideToLock', { defaultValue: 'Up to lock' })}
            </span>
          </>
        )}
        {phase === 'locked' && (
          <>
            <button type="button" onClick={discard} aria-label={t('voiceMessage.delete', { defaultValue: 'Delete' })} className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-destructive">
              <Trash2 className="h-5 w-5" />
            </button>
            <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden />
            <span className="flex-1 font-mono text-sm tabular-nums text-foreground">{clock(seconds)}</span>
            <button type="button" onClick={stopLocked} aria-label={t('voiceMessage.stop', { defaultValue: 'Stop to listen back' })} className="rounded-full border border-border p-2 text-red-500 hover:bg-accent">
              <Square className="h-5 w-5" />
            </button>
          </>
        )}
        {(phase === 'review' || phase === 'sending') && review && (
          <>
            <button type="button" onClick={discard} disabled={phase === 'sending'} aria-label={t('voiceMessage.delete', { defaultValue: 'Delete' })} className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50">
              <Trash2 className="h-5 w-5" />
            </button>
            <audio src={review.url} controls className="h-10 min-w-0 flex-1" />
            <button type="button" onClick={() => void send(review)} disabled={phase === 'sending'} aria-label={t('voiceMessage.send', { defaultValue: 'Send voice message' })} className="rounded-full bg-primary p-2.5 text-primary-foreground hover:brightness-110 disabled:opacity-60">
              {phase === 'sending' ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </>
        )}
        {phase === 'sending' && !review && (
          <span className="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('voiceMessage.sending', { defaultValue: 'Transcribing and sending…' })}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );

  return (
    <span className="relative inline-flex">
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
        aria-label={t('voiceMessage.button', { defaultValue: 'Tap to dictate, hold to record a voice message' })}
        title={t('voiceMessage.button', { defaultValue: 'Tap to dictate, hold to record a voice message' })}
        className={cn(
          'inline-flex h-8 w-8 touch-none select-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          (phase === 'holding' || recording) && 'scale-125 bg-red-500/15 text-red-500',
        )}
      >
        {phase === 'idle' ? dictationIcon : <Mic className="h-4 w-4" />}
      </button>
      {bar}
    </span>
  );
}
