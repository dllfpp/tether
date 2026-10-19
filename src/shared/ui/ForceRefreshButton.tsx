import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { cn } from '@/shared/utils';

/**
 * CloudCLI live: in the installed app (no reload button, and the service
 * worker keeps serving the cached build) this clears the caches, asks the
 * service worker to update, and reloads, so a new deploy shows at once.
 * Rendered by the sidebar header, next to sort, sync and collapse.
 */
export function ForceRefreshButton({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  const { isPWA } = useDeviceSettings({ trackPWA: true });
  const [isRefreshing, setIsRefreshing] = useState(false);
  if (!isPWA) {
    return null;
  }

  const forceRefresh = async () => {
    setIsRefreshing(true);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
    } finally {
      window.location.reload();
    }
  };

  return (
    <button
      type="button"
      onClick={() => void forceRefresh()}
      disabled={isRefreshing}
      aria-label="Reload the app"
      title="Reload the app"
      className={className}
    >
      <RotateCw className={cn(iconClassName, isRefreshing && 'animate-spin')} />
    </button>
  );
}
