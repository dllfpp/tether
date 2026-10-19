import { useState } from 'react';
import { Check, Copy, GitMerge } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UPSTREAM_BASE_VERSION } from '@/shared/constants';
import { copyTextToClipboard } from '@/shared/utils';

type ForkUpgradeNoticeProps = {
  latestVersion: string | null;
  onClose: () => void;
};

/**
 * Used by the version-upgrade module in place of the upgrade command: this
 * copy is a modified CloudCLI, and the built-in command would install the
 * original elsewhere without touching it. A new original release has to be
 * merged into the fork instead; the notice hands over the request to make.
 */
export default function ForkUpgradeNotice({ latestVersion, onClose }: ForkUpgradeNoticeProps) {
  const { t } = useTranslation();
  // Confirms the copy for a moment, since the clipboard gives no feedback of its own.
  const [copied, setCopied] = useState(false);
  // Version numbers are appended rather than interpolated, so they show even
  // where translations are not loaded.
  const request = `${t('live.fork.request', { defaultValue: 'Align Tether with CloudCLI UI' })} v${latestVersion ?? ''}`;

  const copyRequest = async () => {
    await copyTextToClipboard(request);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-100">
        <GitMerge className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">
            {t('live.fork.title', { defaultValue: 'This is Tether, based on CloudCLI UI' })} {UPSTREAM_BASE_VERSION}
          </p>
          <p>
            {t('live.fork.body', {
              defaultValue: 'The usual update would install the original CloudCLI somewhere else and leave this copy as it is. The new version has to be merged into the fork: ask Claude with the request below.',
            })}
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-gray-100 p-3 font-mono text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">
        {request}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 sm:min-h-9"
        >
          {t('versionUpdate.buttons.later', { defaultValue: 'Later' })}
        </button>
        <button
          type="button"
          onClick={() => void copyRequest()}
          className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 sm:min-h-9"
        >
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied
            ? t('live.fork.copied', { defaultValue: 'Copied' })
            : t('live.fork.copyRequest', { defaultValue: 'Copy request' })}
        </button>
      </div>
    </div>
  );
}
