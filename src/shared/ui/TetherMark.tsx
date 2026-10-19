import { cn } from '@/shared/utils';

type TetherMarkProps = {
  className?: string;
};

/**
 * The Tether brand mark: a dot (you) tied by a line to a ring (the running
 * job), on the primary tile. Same drawing as public/logo.svg, which
 * scripts/generate-icons.mjs writes. Decorative: the wordmark next to it, or
 * the caller's label, names the app.
 */
export default function TetherMark({ className }: TetherMarkProps) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cn('h-7 w-7 flex-shrink-0', className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M10.5 21.5C10.5 16.2 15.8 16.4 19.2 12.9" fill="none" className="stroke-primary-foreground" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="10.5" cy="21.5" r="3" className="fill-primary-foreground" />
      <circle cx="21.5" cy="10.5" r="3.2" fill="none" className="stroke-primary-foreground" strokeWidth="2.4" />
    </svg>
  );
}
