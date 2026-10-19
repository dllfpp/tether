import { useEffect, useRef, useState } from 'react';
import { EyeOff, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui';

/** Seconds the final button stays locked after the step opens. */
const CONFIRM_DELAY_SECONDS = 5;

type TypedConfirmStepProps = {
  action: 'archive' | 'delete';
  /** Project or conversation name, part of the phrase to type. */
  targetName: string;
  /** What the action does, shown above the box. */
  consequence: string;
  onConfirm: () => void;
  onBack: () => void;
};

/**
 * CloudCLI live: second step before archiving or deleting a project or a
 * conversation. The reader types `archive <name>` or `delete <name>` by hand
 * (case-sensitive, paste and drop refused), and the button also waits a few
 * seconds, so a stray tap or a reflexive Enter never removes anything.
 */
export default function TypedConfirmStep({ action, targetName, consequence, onConfirm, onBack }: TypedConfirmStepProps) {
  const phrase = `${action} ${targetName.trim() || 'this'}`;
  const [typed, setTyped] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(CONFIRM_DELAY_SECONDS);
  const backRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    backRef.current?.focus();
    const timer = window.setInterval(() => {
      setSecondsLeft((left) => {
        if (left <= 1) window.clearInterval(timer);
        return Math.max(0, left - 1);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const matches = typed === phrase;
  const ready = matches && secondsLeft === 0;
  const isDelete = action === 'delete';

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-muted/30 p-4">
      <p className={isDelete ? 'text-sm font-medium text-red-700 dark:text-red-300' : 'text-sm font-medium text-foreground'}>
        {consequence}
      </p>
      <label className="text-xs text-muted-foreground" htmlFor="typed-confirm-input">
        To confirm, type <span className="select-none whitespace-pre-wrap break-all rounded bg-muted px-1 py-0.5 font-mono text-foreground">{phrase}</span>
      </label>
      <input
        id="typed-confirm-input"
        type="text"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={typed.length > 0 && !matches}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 sm:text-sm"
      />
      <Button
        variant={isDelete ? 'destructive' : 'outline'}
        className={isDelete ? 'w-full justify-start bg-red-600 text-white hover:bg-red-700 disabled:opacity-50' : 'w-full justify-start disabled:opacity-50'}
        disabled={!ready}
        onClick={() => {
          if (ready) onConfirm();
        }}
      >
        {isDelete ? <Trash2 className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
        {isDelete ? 'Delete permanently' : 'Archive'}
        {matches && secondsLeft > 0 ? ` (${secondsLeft})` : ''}
      </Button>
      <Button ref={backRef} variant="ghost" className="w-full" onClick={onBack}>
        Cancel
      </Button>
    </div>
  );
}
