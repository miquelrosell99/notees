/**
 * Login view component
 */
import { useState, useMemo } from 'react';
import { Spinner } from '@/components/core/Spinner';
import './LoginView.css';
import { useAuthStore } from '@/stores';
import { Button } from '../components/core/Button';
import { TextField } from '../components/core/TextField';

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

export function LoginView({ registrationEnabled = true }: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { login, register, isLoading, error, clearError } = useAuthStore();

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
        await register(email, password);
      } else {
        await login(email, password);
      }
    } catch {
      // Error is handled by store
    }
  };

  const displayError = localError || error;

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
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Enter email"
            required
            autoComplete="email"
          />

          <TextField
            id="password"
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            required
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />

          {isRegister && (
            <TextField
              id="confirm-password"
              type="password"
              label="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              required
              autoComplete="new-password"
            />
          )}

          {isRegister && passwordError && (
            <div className="error-message">{passwordError}</div>
          )}

          {displayError && <div className="error-message">{displayError}</div>}

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
