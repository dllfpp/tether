import { useCallback, useEffect, useRef, useState } from 'react';

// Same order as dictation: iOS Safari records mp4 (older) or webm/opus (18.4+).
const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

function pickMime(): string {
  for (const type of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported can throw on some iOS versions.
    }
  }
  return '';
}

/** A finished recording, kept until it is sent or thrown away. */
export type VoiceRecording = {
  file: File;
  url: string;
  seconds: number;
};

/**
 * CloudCLI live: used by chat's VoiceMessageButton to record a voice message.
 * `start` opens the mic; `finish` stops and resolves with the recording (null
 * when cancelled or too short to hold any speech).
 */
export function useVoiceMessage(onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const pendingStopRef = useRef<'cancel' | 'keep' | null>(null);

  const release = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  };

  useEffect(() => () => {
    pendingStopRef.current = 'cancel';
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    release();
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current) return false;
    pendingStopRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      // The finger may already be up while the permission prompt was open.
      if (pendingStopRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const mimeType = pickMime();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(250);
      startedAtRef.current = Date.now();
      setSeconds(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 250);
      navigator.vibrate?.(15);
      return true;
    } catch (error) {
      const name = (error as { name?: string })?.name;
      onError(name === 'NotAllowedError' ? 'Microphone access denied.' : 'Could not start the microphone.');
      release();
      return false;
    }
  }, [onError]);

  const finish = useCallback((mode: 'keep' | 'cancel'): Promise<VoiceRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      pendingStopRef.current = mode;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        const type = recorder.mimeType || 'audio/mp4';
        const blob = new Blob(chunksRef.current, { type });
        release();
        if (mode === 'cancel' || elapsed < 0.7 || blob.size < 800) {
          resolve(null);
          return;
        }
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        const file = new File([blob], `voice-${stamp}.${extension}`, { type });
        resolve({ file, url: URL.createObjectURL(blob), seconds: Math.max(1, Math.round(elapsed)) });
      };
      recorder.stop();
    });
  }, []);

  return { recording, seconds, start, finish };
}
