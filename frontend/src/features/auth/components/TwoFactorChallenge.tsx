/**
 * TwoFactorChallenge
 *
 * Login-time second-factor UI. Renders one of three states driven by the auth
 * store: the backup-codes panel (after enabling), the verification code form
 * (purpose === 'verify'), or the enrollment wizard (purpose === 'setup').
 */
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Spinner } from '@/components/ui/Spinner';
import './TwoFactorChallenge.css';

export function TwoFactorChallenge() {
  const twoFactor = useAuthStore((s) => s.twoFactor);
  const backupCodes = useAuthStore((s) => s.backupCodes);
  const setupData = useAuthStore((s) => s.setupData);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const verifyTwoFactor = useAuthStore((s) => s.verifyTwoFactor);
  const beginTwoFactorSetup = useAuthStore((s) => s.beginTwoFactorSetup);
  const confirmTwoFactorSetup = useAuthStore((s) => s.confirmTwoFactorSetup);
  const cancelTwoFactor = useAuthStore((s) => s.cancelTwoFactor);
  const clearBackupCodes = useAuthStore((s) => s.clearBackupCodes);

  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const setupStarted = useRef(false);

  // Kick off enrollment exactly once for the forced-setup branch. The ref
  // guards against React StrictMode's double invocation in development.
  useEffect(() => {
    if (twoFactor?.purpose === 'setup' && !setupData && !setupStarted.current) {
      setupStarted.current = true;
      beginTwoFactorSetup().catch(() => {
        // Error is surfaced via the store.
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twoFactor?.purpose]);

  const handleCopy = async () => {
    if (!backupCodes) return;
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      await verifyTwoFactor(code.trim());
    } catch {
      // Error is surfaced via the store.
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      await confirmTwoFactorSetup(code.trim());
    } catch {
      // Error is surfaced via the store.
    }
  };

  // 1. Backup codes panel
  if (backupCodes) {
    return (
      <div className="totp-challenge">
        <h1>Save your backup codes</h1>
        <p className="totp-subtitle">
          Each code can be used once if you lose access to your authenticator. Store them
          somewhere safe — they will not be shown again.
        </p>

        <ul className="totp-backup-codes">
          {backupCodes.map((c) => (
            <li key={c}><code>{c}</code></li>
          ))}
        </ul>

        {error && <div className="error-message" role="alert">{error}</div>}

        <div className="totp-actions">
          <Button variant="default" onClick={handleCopy} disabled={isLoading}>
            {copied ? 'Copied' : 'Copy codes'}
          </Button>
          <Button variant="primary" onClick={clearBackupCodes} disabled={isLoading}>
            I&apos;ve saved these
          </Button>
        </div>
      </div>
    );
  }

  // 2. Verification challenge
  if (twoFactor?.purpose === 'verify') {
    return (
      <div className="totp-challenge">
        <h1>Two-factor authentication</h1>
        <p className="totp-subtitle">Enter the 6-digit code from your authenticator app.</p>

        <form onSubmit={handleVerify} className="totp-form">
          <TextField
            id="totp-code"
            name="totp-code"
            label="Authentication code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            disabled={isLoading}
          />

          <p className="totp-hint">You can also enter one of your backup codes.</p>

          {error && <div className="error-message" role="alert">{error}</div>}

          <div className="totp-actions">
            <Button variant="ghost" type="button" onClick={cancelTwoFactor} disabled={isLoading}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isLoading || !code.trim()}>
              {isLoading ? <Spinner size="sm" label="Verifying..." /> : 'Verify'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  // 3. Enrollment wizard (purpose === 'setup')
  return (
    <div className="totp-challenge">
      <h1>Set up two-factor authentication</h1>
      <p className="totp-subtitle">
        Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
      </p>

      {!setupData ? (
        <div className="totp-loading">
          <Spinner centered label="Generating setup..." />
        </div>
      ) : (
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
            id="totp-confirm-code"
            name="totp-confirm-code"
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
            <Button variant="ghost" type="button" onClick={cancelTwoFactor} disabled={isLoading}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={isLoading || !code.trim()}>
              {isLoading ? <Spinner size="sm" label="Enabling..." /> : 'Enable'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
