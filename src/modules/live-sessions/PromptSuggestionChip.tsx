import { CornerDownLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type PromptSuggestionChipProps = {
  suggestion: string | null;
  onAccept: () => void;
};

/**
 * Used by the chat module above the composer on touch screens, where there is
 * no Tab key: one tap puts the suggested next prompt into the input. On
 * desktop the suggestion appears as the input's grey text instead.
 */
export default function PromptSuggestionChip({ suggestion, onAccept }: PromptSuggestionChipProps) {
  const { t } = useTranslation();
  if (!suggestion) {
    return null;
  }

  return (
    <div className="mb-2 hidden px-1 [@media(pointer:coarse)]:flex">
      <button
        type="button"
        onClick={onAccept}
        aria-label={t('live.useSuggestion', { defaultValue: 'Use suggested prompt' })}
        className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-border bg-card px-4 text-left text-sm text-muted-foreground transition-colors active:bg-muted"
      >
        <CornerDownLeft className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{suggestion}</span>
      </button>
    </div>
  );
}
