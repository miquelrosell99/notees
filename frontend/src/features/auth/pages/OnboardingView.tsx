/**
 * Onboarding view — First-boot admin creation.
 *
 * Shown when no users exist in the system. Creating the first user
 * automatically makes them an admin.
 */
import { useState, useMemo } from 'react';
import './OnboardingView.css';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { register } from '@/features/auth/api/auth';
import { setAuthToken, setUserData } from '@/utils/auth';
import { useAuthStore } from '@/stores';

interface OnboardingViewProps {
  onComplete: () => void;
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

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordError = useMemo(() => {
    if (!password) return null;
    return validatePassword(password);
  }, [password]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    const validationError = validatePassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsLoading(true);

    try {
      const response = await register({ email, password, name });
      setAuthToken(response.access_token);
      setUserData(response.user);
      useAuthStore.getState().setUser(response.user);
      onComplete();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create admin account';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="onboarding-page">
      <div className="onboarding-container">
        <h1>Welcome to Notees</h1>
        <p className="onboarding-subtitle">
          Create your admin account to start using Notees.
        </p>

        <form onSubmit={handleSubmit} className="onboarding-form">
          <TextField
            id="onboarding-name"
            name="name"
            type="text"
            label="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
          />

          <TextField
            id="onboarding-email"
            name="email"
            type="email"
            label="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            required
            autoComplete="email"
          />

          <TextField
            id="onboarding-password"
            name="password"
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a strong password"
            required
            autoComplete="new-password"
          />

          <TextField
            id="onboarding-confirm-password"
            name="confirm-password"
            type="password"
            label="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter password"
            required
            autoComplete="new-password"
          />

          {passwordError && <div className="error-message">{passwordError}</div>}
          {error && <div className="error-message">{error}</div>}

          <Button type="submit" variant="primary" fullWidth disabled={isLoading || !!passwordError}>
            {isLoading ? <Spinner size="sm" label="Creating account..." /> : 'Create Admin Account'}
          </Button>
        </form>
      </div>
    </div>
  );
}
