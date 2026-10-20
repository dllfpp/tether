import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, Loader2, LogOut, Smartphone, Trash2 } from 'lucide-react';

import { useAuth } from '@/modules/auth';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import { api, readApiErrorMessage } from '@/shared/api';

type PasskeySummary = {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type Factors = {
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  passkeys: PasskeySummary[];
};

type TotpSetup = { secret: string; qrDataUrl: string };

// Which code-confirmed action the small code form is collecting a code for.
type CodeAction = 'enable' | 'disable' | 'regenerate';

const inputClassName = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';
const primaryButtonClassName = 'inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60';
const secondaryButtonClassName = 'inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60';

async function readError(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  return readApiErrorMessage(payload) ?? `HTTP ${response.status}`;
}

/** Rendered by Settings for the "security" tab: passkeys, authenticator app and recovery codes. */
export default function SecuritySettingsTab() {
  const { t, i18n } = useTranslation('auth');
  const { logout } = useAuth();
  const [factors, setFactors] = useState<Factors | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyName, setPasskeyName] = useState('');
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const [codeAction, setCodeAction] = useState<CodeAction | null>(null);
  const [code, setCode] = useState('');
  // Shown once, right after they are made; never readable again from the server.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const canUsePasskey = window.isSecureContext && 'PublicKeyCredential' in window;

  const loadFactors = useCallback(async () => {
    const response = await api.auth.mfa.factors();
    if (response.ok) {
      setFactors(await response.json() as Factors);
    } else {
      setError(await readError(response));
    }
  }, []);

  useEffect(() => {
    void loadFactors();
  }, [loadFactors]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await action();
    } catch (caughtError) {
      // Closing the system passkey sheet is a choice, not an error.
      if (!(caughtError instanceof Error && caughtError.name === 'NotAllowedError')) {
        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const addPasskey = () => run(async () => {
    const optionsResponse = await api.auth.mfa.passkeyOptions();
    if (!optionsResponse.ok) throw new Error(await readError(optionsResponse));
    const registration = await startRegistration({ optionsJSON: await optionsResponse.json() });
    const response = await api.auth.mfa.addPasskey(registration, passkeyName.trim());
    if (!response.ok) throw new Error(await readError(response));
    setPasskeyName('');
    setNotice(t('security.passkeyAdded'));
    await loadFactors();
  });

  const deletePasskey = (passkey: PasskeySummary) => {
    if (!window.confirm(t('security.confirmDeletePasskey', { name: passkey.name }))) return;
    void run(async () => {
      const response = await api.auth.mfa.deletePasskey(passkey.id);
      if (!response.ok) throw new Error(await readError(response));
      await loadFactors();
    });
  };

  const startTotp = () => run(async () => {
    const response = await api.auth.mfa.startTotpSetup();
    if (!response.ok) throw new Error(await readError(response));
    setTotpSetup(await response.json() as TotpSetup);
    setCodeAction('enable');
    setCode('');
  });

  const cancelCode = () => {
    setCodeAction(null);
    setTotpSetup(null);
    setCode('');
    setError('');
  };

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const action = codeAction;
    if (!action || !code.trim()) return;
    void run(async () => {
      const response = action === 'enable'
        ? await api.auth.mfa.enableTotp(code.trim())
        : action === 'disable'
          ? await api.auth.mfa.disableTotp(code.trim())
          : await api.auth.mfa.regenerateRecoveryCodes(code.trim());
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json() as { recoveryCodes?: string[] };
      if (payload.recoveryCodes) {
        setRecoveryCodes(payload.recoveryCodes);
        setCopied(false);
      }
      setCodeAction(null);
      setTotpSetup(null);
      setCode('');
      await loadFactors();
    });
  };

  const copyRecoveryCodes = async () => {
    if (!recoveryCodes) return;
    await navigator.clipboard.writeText(recoveryCodes.join('\n')).catch(() => undefined);
    setCopied(true);
  };

  const formatDate = (value: string) => {
    // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  };

  const codeForm = codeAction && (
    <form onSubmit={submitCode} className="mt-3 space-y-3">
      {codeAction === 'enable' && totpSetup && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <img
            src={totpSetup.qrDataUrl}
            width={220}
            height={220}
            alt=""
            className="h-[180px] w-[180px] flex-shrink-0 rounded-lg bg-white p-1"
          />
          <div className="min-w-0 space-y-2 text-sm text-muted-foreground">
            <p>{t('security.scanQr')}</p>
            <p>
              {t('security.secretKey')}:{' '}
              <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{totpSetup.secret}</code>
            </p>
          </div>
        </div>
      )}
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder={codeAction === 'enable' ? t('security.confirmCode') : t('security.codeToConfirm')}
        aria-label={codeAction === 'enable' ? t('security.confirmCode') : t('security.codeToConfirm')}
        autoComplete="one-time-code"
        className={inputClassName}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !code.trim()} className={primaryButtonClassName}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('security.confirm')}
        </button>
        <button type="button" onClick={cancelCode} disabled={busy} className={secondaryButtonClassName}>
          {t('security.cancel')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="space-y-6 md:space-y-8">
      <SettingsSection title={t('security.title')} description={t('security.description')}>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {!factors && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </SettingsSection>

      {recoveryCodes && (
        <SettingsSection title={t('security.recoveryTitle')} description={t('security.recoveryHint')}>
          <SettingsCard className="space-y-3 p-4">
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-foreground">
              {recoveryCodes.map((recoveryCode) => <li key={recoveryCode}>{recoveryCode}</li>)}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copyRecoveryCodes} className={secondaryButtonClassName}>
                {copied ? t('security.copied') : t('security.copy')}
              </button>
              <button type="button" onClick={() => setRecoveryCodes(null)} className={primaryButtonClassName}>
                {t('security.done')}
              </button>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {factors && (
        <>
          <SettingsSection title={t('security.passkeys')}>
            <SettingsCard className="space-y-3 p-4">
              {factors.passkeys.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('security.noPasskeys')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {factors.passkeys.map((passkey) => (
                    <li key={passkey.id} className="flex items-center gap-3 py-2">
                      <Fingerprint className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{passkey.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {passkey.lastUsedAt
                            ? t('security.lastUsed', { date: formatDate(passkey.lastUsedAt) })
                            : t('security.neverUsed')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => deletePasskey(passkey)}
                        disabled={busy}
                        aria-label={t('security.deletePasskey')}
                        title={t('security.deletePasskey')}
                        className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-60"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {canUsePasskey ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={passkeyName}
                    onChange={(event) => setPasskeyName(event.target.value)}
                    placeholder={t('security.passkeyName')}
                    aria-label={t('security.passkeyName')}
                    maxLength={60}
                    className={inputClassName}
                    disabled={busy}
                  />
                  <button type="button" onClick={addPasskey} disabled={busy} className={`${primaryButtonClassName} flex-shrink-0`}>
                    <Fingerprint className="h-4 w-4" />
                    {t('security.addPasskey')}
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('security.passkeyNeedsDomain')}</p>
              )}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title={t('security.totp')}>
            <SettingsCard className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Smartphone className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 text-sm text-foreground">
                  {factors.totpEnabled
                    ? t('security.totpOn', { count: factors.recoveryCodesLeft })
                    : t('security.totpOff')}
                </p>
                {!codeAction && (factors.totpEnabled ? (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => { setCodeAction('regenerate'); setCode(''); }} disabled={busy} className={secondaryButtonClassName}>
                      <KeyRound className="h-4 w-4" />
                      {t('security.regenerateCodes')}
                    </button>
                    <button type="button" onClick={() => { setCodeAction('disable'); setCode(''); }} disabled={busy} className={secondaryButtonClassName}>
                      {t('security.disableTotp')}
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={startTotp} disabled={busy} className={primaryButtonClassName}>
                    {t('security.enableTotp')}
                  </button>
                ))}
              </div>
              {codeForm}
            </SettingsCard>
          </SettingsSection>
        </>
      )}

      <SettingsSection title={t('security.session')} description={t('security.sessionHint')}>
        <button type="button" onClick={logout} className={secondaryButtonClassName}>
          <LogOut className="h-4 w-4" />
          {t('security.logout')}
        </button>
      </SettingsSection>
    </div>
  );
}
