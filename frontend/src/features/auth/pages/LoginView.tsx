/**
 * Login view component
 */
import { useId, useMemo, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import './LoginView.css';
import { useAuthStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Checkbox } from '@/components/ui/Checkbox';

interface LoginViewProps {
  registrationEnabled?: boolean;
}

function validatePassword(value: string): string | null {
  if (value.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(value)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(value)) return 'Password must contain at least one lowercase letter';
  if (!/\d/.test(value)) return 'Password must contain at least one digit';
  if (!/[!@#$%^&*()_+\-=[\]{}|;':"\\",./<>?`~]/.test(value)) {
    return 'Password must contain at least one special character';
  }
  return null;
}

export function LoginView({ registrationEnabled = false }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const passwordError = useMemo(() => {
    if (!isRegister || !password) return null;
    return validatePassword(password);
  }, [password, isRegister]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLocalError(null);

    if (isRegister) {
      if (password !== confirmPassword) {
        setLocalError('Passwords do not match');
        return;
      }
      const validationError = validatePassword(password);
      if (validationError) {
        setLocalError(validationError);
        return;
      }
    }

    try {
      if (isRegister) {
        await register(email, password, undefined, rememberMe);
      } else {
        await login(email, password, rememberMe);
      }
    } catch {
      // Error is handled by store
    }
  };

  const displayError = localError || error;
  const formErrorId = useId();

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Notees</h1>
        <p className="login-subtitle">
          {isRegister ? 'Create your account' : 'Sign in to continue'}
        </p>

        <form onSubmit={handleSubmit} className="login-form">
          <TextField
            id="email"
            name="email"
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email"
            required
            autoComplete={isRegister ? 'email' : 'username'}
          />

          <TextField
            id="password"
            name="password"
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            required
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            error={!!passwordError}
            errorMessage={passwordError ?? undefined}
            aria-describedby={displayError ? formErrorId : undefined}
          />

          {isRegister && (
            <TextField
              id="confirm-password"
              name="confirm-password"
              type="password"
              label="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              required
              autoComplete="new-password"
              error={displayError === 'Passwords do not match'}
              errorMessage={displayError === 'Passwords do not match' ? displayError : undefined}
            />
          )}

          {isRegister && passwordError && (
            <div className="error-message" role="alert">{passwordError}</div>
          )}

          {!isRegister && (
            <Checkbox
              id="remember-me"
              name="remember-me"
              label="Keep me signed in"
              density="minimal"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
          )}

          {displayError && <div id={formErrorId} className="error-message" role="alert">{displayError}</div>}

          <Button type="submit" variant="primary" fullWidth disabled={isLoading || (isRegister && !!passwordError)}>
            {isLoading ? <Spinner size="sm" label={isRegister ? 'Registering...' : 'Signing in...'} /> : isRegister ? 'Register' : 'Sign In'}
          </Button>
        </form>

        {registrationEnabled && (
          <p className="login-toggle">
            {isRegister ? (
              <>
                Already have an account?{' '}
                <Button variant="ghost" size="xs" type="button" onClick={() => setIsRegister(false)}>
                  Sign in
                </Button>
              </>
            ) : (
              <>
                Don&apos;t have an account?{' '}
                <Button variant="ghost" size="xs" type="button" onClick={() => setIsRegister(true)}>
                  Register
                </Button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
