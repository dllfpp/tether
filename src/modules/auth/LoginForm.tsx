import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, KeyRound, Loader2, Lock, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, login, loginWithCode, loginWithPasskey } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // CloudCLI live: set after a right password when the authenticator is on.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // WebAuthn exists only in a secure context (HTTPS or localhost).
  const canUsePasskey = typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window;

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        if ('mfaToken' in result) {
          setMfaToken(result.mfaToken);
          setCode('');
        } else {
          setErrorMessage(result.error);
        }
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  const handleCodeSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!mfaToken || !code.trim()) return;
      setErrorMessage('');
      setIsSubmitting(true);
      const result = await loginWithCode(mfaToken, code.trim());
      if (!result.success && 'error' in result) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [code, loginWithCode, mfaToken],
  );

  const handlePasskey = useCallback(async () => {
    setErrorMessage('');
    setIsSubmitting(true);
    const result = await loginWithPasskey();
    if (!result.success && 'error' in result) {
      setErrorMessage(result.error);
    }
    setIsSubmitting(false);
  }, [loginWithPasskey]);

  const submitClassName = 'flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

  if (mfaToken) {
    return (
      <AuthScreenLayout
        title={t('login.codeTitle')}
        description={t('login.codeDescription')}
        footerText={t('login.footerText')}
      >
        <form onSubmit={handleCodeSubmit} className="space-y-4">
          <AuthInputField
            id="mfa-code"
            label={t('login.codeTitle')}
            value={code}
            onChange={setCode}
            placeholder={t('login.codePlaceholder')}
            isDisabled={isSubmitting}
            autoComplete="one-time-code"
            icon={KeyRound}
          />

          <AuthErrorAlert errorMessage={errorMessage} />

          <button type="submit" disabled={isSubmitting || !code.trim()} className={submitClassName}>
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('login.codeSubmit')}
          </button>
          <button
            type="button"
            onClick={() => { setMfaToken(null); setErrorMessage(''); }}
            disabled={isSubmitting}
            className="w-full text-sm text-muted-foreground hover:text-foreground"
          >
            {t('login.codeBack')}
          </button>
        </form>
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText={t('login.footerText')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className={submitClassName}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>
      </form>

      {canUsePasskey && (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('login.or')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            onClick={handlePasskey}
            disabled={isSubmitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Fingerprint className="h-4 w-4" />
            {t('login.passkey')}
          </button>
        </>
      )}
    </AuthScreenLayout>
  );
}
