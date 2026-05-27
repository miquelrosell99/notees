/**
 * Onboarding view — First-boot admin creation.
 *
 * Shown when no users exist in the system. Creating the first user
 * automatically makes them an admin.
 */
import { useState } from 'react';
import './OnboardingView.css';
import { Button } from '@/components/core/Button';
import { Spinner } from '@/components/core/Spinner';
import { TextField } from '@/components/core/TextField';
import { register } from '@/api/auth';
import { setAuthToken, setUserData } from '@/utils/auth';
import { useAuthStore } from '@/stores';

interface OnboardingViewProps {
  onComplete: () => void;
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
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
          Create your admin account to get started.
        </p>

        <form onSubmit={handleSubmit} className="onboarding-form">
          <TextField
            id="onboarding-name"
            type="text"
            label="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
          />

          <TextField
            id="onboarding-email"
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
            type="password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a strong password"
            required
            autoComplete="new-password"
          />

          {error && <div className="error-message">{error}</div>}

          <Button type="submit" variant="primary" fullWidth disabled={isLoading}>
            {isLoading ? <Spinner size="sm" label="Creating account..." /> : 'Create Admin Account'}
          </Button>
        </form>
      </div>
    </div>
  );
}
