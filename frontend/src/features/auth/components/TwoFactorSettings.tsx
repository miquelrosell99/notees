/**
 * TwoFactorSettings
 *
 * Voluntary two-factor opt-in/out for logged-in users (cookie session). Lives
 * inside the user settings surface. Reuses the auth store's 2FA actions and
 * mirrors the enrollment markup used by TwoFactorChallenge.
 */
import { useState } from 'react';
import { useAuthStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Spinner } from '@/components/ui/Spinner';
import './TwoFactorSettings.css';

type SettingsMode = 'idle' | 'enabling' | 'disable' | 'regenerate';

export function TwoFactorSettings() {
  const user = useAuthStore((s) => s.user);
  const setupData = useAuthStore((s) => s.setupData);
  const backupCodes = useAuthStore((s) => s.backupCodes);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const beginTwoFactorSetup = useAuthStore((s) => s.beginTwoFactorSetup);
  const confirmTwoFactorSetup = useAuthStore((s) => s.confirmTwoFactorSetup);
  const cancelTwoFactor = useAuthStore((s) => s.cancelTwoFactor);
  const clearBackupCodes = useAuthStore((s) => s.clearBackupCodes);
  const disableTwoFactor = useAuthStore((s) => s.disableTwoFactor);
  const regenerateBackupCodes = useAuthStore((s) => s.regenerateBackupCodes);
  const clearError = useAuthStore((s) => s.clearError);

  const [mode, setMode] = useState<SettingsMode>('idle');
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const resetLocal = () => {
    setCode('');
    setCurrentPassword('');
    setCopied(false);
  };

  const goIdle = () => {
    resetLocal();
    clearError();
    setMode('idle');
  };

  const handleCopy = async () => {
    if (!backupCodes) return;
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleStartEnable = async () => {
    resetLocal();
    setMode('enabling');
    try {
      await beginTwoFactorSetup();
    } catch {
      setMode('idle');
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      await confirmTwoFactorSetup(code.trim());
      setCode('');
    } catch {
      // Error is surfaced via the store.
    }
  };

  const handleCancelEnable = () => {
    cancelTwoFactor();
    goIdle();
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    const opts = currentPassword
      ? { current_password: currentPassword }
      : code.trim()
        ? { code: code.trim() }
        : null;
    if (!opts) return;
    try {
      await disableTwoFactor(opts);
      goIdle();
    } catch {
      // Error is surfaced via the store.
    }
  };

  const handleRegenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      await regenerateBackupCodes(code.trim());
      setCode('');
      setMode('idle');
    } catch {
      // Error is surfaced via the store.
    }
  };

  const handleSavedCodes = () => {
    clearBackupCodes();
    goIdle();
  };

  // Backup codes panel — shown after enable or regenerate.
  if (backupCodes) {
    return (
      <div className="totp-settings">
        <p className="totp-settings__lead">
          Save these backup codes somewhere safe. Each can be used once if you lose access to your
          authenticator — they will not be shown again.
        </p>
        <ul className="totp-backup-codes">
          {backupCodes.map((c) => (
            <li key={c}><code>{c}</code></li>
          ))}
        </ul>
        <div className="totp-actions">
          <Button variant="default" onClick={handleCopy} disabled={isLoading}>
            {copied ? 'Copied' : 'Copy codes'}
          </Button>
          <Button variant="primary" onClick={handleSavedCodes} disabled={isLoading}>
            I&apos;ve saved these
          </Button>
        </div>
      </div>
    );
  }

  if (!user?.totp_enabled) {
    // Enrollment flow (voluntary — cookie session, twoFactor is null).
    if (mode === 'enabling') {
      if (!setupData) {
        return (
          <div className="totp-settings">
            <Spinner centered label="Generating setup..." />
          </div>
        );
      }
      return (
        <div className="totp-settings">
          <p className="totp-settings__lead">
            Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
          </p>
          <form onSubmit={handleConfirmSetup} className="totp-form">
            <div
              className="totp-qr"
              dangerouslySetInnerHTML={{ __html: setupData.qr_svg }}
            />
            <div className="totp-manual">
              <span className="totp-manual__label">Can&apos;t scan? Enter this key manually:</span>
              <code className="totp-manual__key">{setupData.secret}</code>
            </div>
            <TextField
              id="totp-settings-confirm-code"
              name="totp-settings-confirm-code"
              label="Authentication code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              disabled={isLoading}
            />
            {error && <div className="error-message" role="alert">{error}</div>}
            <div className="totp-actions">
              <Button variant="ghost" type="button" onClick={handleCancelEnable} disabled={isLoading}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={isLoading || !code.trim()}>
                {isLoading ? <Spinner size="sm" label="Enabling..." /> : 'Enable'}
              </Button>
            </div>
          </form>
        </div>
      );
    }

    return (
      <div className="totp-settings">
        <p className="totp-settings__lead">
          Add an extra layer of security by requiring a time-based code from an authenticator app
          when you sign in.
        </p>
        {error && <div className="error-message" role="alert">{error}</div>}
        <div className="totp-actions">
          <Button variant="primary" onClick={handleStartEnable} disabled={isLoading}>
            {isLoading ? <Spinner size="sm" label="Starting..." /> : 'Enable two-factor authentication'}
          </Button>
        </div>
      </div>
    );
  }

  // user.totp_enabled === true
  if (mode === 'disable') {
    return (
      <div className="totp-settings">
        <p className="totp-settings__lead">
          Confirm with your current password or a valid authenticator/backup code to disable
          two-factor authentication.
        </p>
        <form onSubmit={handleDisable} className="totp-form">
          <TextField
            id="totp-disable-password"
            name="totp-disable-password"
            type="password"
            label="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            disabled={isLoading}
          />
          <div className="totp-settings__or">or</div>
          <TextField
            id="totp-disable-code"
            name="totp-disable-code"
            label="Authentication / backup code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            disabled={isLoading}
          />
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="totp-actions">
            <Button variant="ghost" type="button" onClick={goIdle} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              disabled={isLoading || (!currentPassword && !code.trim())}
            >
              {isLoading ? <Spinner size="sm" label="Disabling..." /> : 'Disable'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (mode === 'regenerate') {
    return (
      <div className="totp-settings">
        <p className="totp-settings__lead">
          Enter a current authenticator code to generate a new set of backup codes. This replaces
          any existing codes.
        </p>
        <form onSubmit={handleRegenerate} className="totp-form">
          <TextField
            id="totp-regenerate-code"
            name="totp-regenerate-code"
            label="Authentication code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            disabled={isLoading}
          />
          {error && <div className="error-message" role="alert">{error}</div>}
          <div className="totp-actions">
            <Button variant="ghost" type="button" onClick={goIdle} disabled={isLoading}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isLoading || !code.trim()}>
              {isLoading ? <Spinner size="sm" label="Regenerating..." /> : 'Regenerate'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="totp-settings">
      <div className="totp-settings__status">
        <span className="totp-settings__badge" aria-label="Two-factor authentication is enabled">
          Enabled
        </span>
        <span className="totp-settings__status-text">
          Two-factor authentication is protecting your account.
        </span>
      </div>
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="totp-actions">
        <Button variant="ghost" onClick={() => { resetLocal(); clearError(); setMode('regenerate'); }} disabled={isLoading}>
          Regenerate backup codes
        </Button>
        <Button variant="danger" onClick={() => { resetLocal(); clearError(); setMode('disable'); }} disabled={isLoading}>
          Disable
        </Button>
      </div>
    </div>
  );
}
