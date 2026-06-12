/**
 * InviteAcceptView — Accept a pending invitation via token.
 *
 * Works without being authenticated. If the user already has an account,
 * they can log in and the invite is auto-accepted. If not, they register.
 */
import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { acceptInvite, getAuthStatus, register, login } from '@/features/auth/api/auth';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { setAuthToken } from '@/utils/auth';
import './EnrollmentView.css';

export function InviteAcceptView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';

  const [step, setStep] = useState<'loading' | 'register' | 'login' | 'accepting' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    getAuthStatus().then((status) => {
      setRegistrationEnabled(status.registration_enabled || status.needs_onboarding);
      // Try to auto-accept if user is already logged in
      const existingToken = localStorage.getItem('auth_token');
      if (existingToken && token) {
        setStep('accepting');
        acceptInvite({ token })
          .then(() => setStep('done'))
          .catch((err) => {
            setError(err.message || 'Failed to accept invite');
            setStep('error');
          });
      } else {
        setStep('register');
      }
    }).catch(() => setStep('register'));
  }, [token]);

  const handleRegister = async () => {
    if (!password || password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setStep('accepting');
    setError(null);
    try {
      const res = await register({ email, password, name: name || undefined });
      setAuthToken(res.access_token);
      await acceptInvite({ token });
      setStep('done');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Registration failed';
      setError(msg);
      setStep('register');
    }
  };

  const handleLogin = async () => {
    setStep('accepting');
    setError(null);
    try {
      const res = await login({ email, password: loginPassword });
      setAuthToken(res.access_token);
      await acceptInvite({ token });
      setStep('done');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Login failed';
      setError(msg);
      setStep('login');
    }
  };

  if (step === 'loading') {
    return (
      <div className="enrollment-view">
        <Spinner size="lg" centered />
      </div>
    );
  }

  if (step === 'accepting') {
    return (
      <div className="enrollment-view">
        <div className="enrollment-view__content">
          <Spinner size="lg" centered label="Accepting invitation…" />
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="enrollment-view">
        <div className="enrollment-view__content">
          <h1>Welcome!</h1>
          <p>Your invitation has been accepted. You now have access to the shared workspace.</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Go to Notees
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'error' && error) {
    return (
      <div className="enrollment-view">
        <div className="enrollment-view__content">
          <h1>Something went wrong</h1>
          <p>{error}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Go to Notees
          </Button>
        </div>
      </div>
    );
  }

  const isRegister = step === 'register';

  return (
    <div className="enrollment-view">
      <div className="enrollment-view__content">
        <h1>You've been invited!</h1>
        <p>Accept your invitation to join the workspace.</p>

        {isRegister ? (
          <>
            {!registrationEnabled && (
              <p className="enrollment-view__hint">Registration is currently disabled. Please ask an admin to create your account.</p>
            )}
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
            <TextField
              label="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
            />
            <TextField
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
            />
            <Button
              variant="primary"
              onClick={handleRegister}
              disabled={!registrationEnabled || !email || !password || !confirmPassword}
            >
              Create account & accept invite
            </Button>
            <p className="enrollment-view__switch">
              Already have an account?{' '}
              <button className="enrollment-view__link" onClick={() => { setStep('login'); setError(null); }}>
                Log in
              </button>
            </p>
          </>
        ) : (
          <>
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
            <TextField
              label="Password"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="Your password"
            />
            <Button
              variant="primary"
              onClick={handleLogin}
              disabled={!email || !loginPassword}
            >
              Log in & accept invite
            </Button>
            <p className="enrollment-view__switch">
              Need an account?{' '}
              <button className="enrollment-view__link" onClick={() => { setStep('register'); setError(null); }}>
                Register
              </button>
            </p>
          </>
        )}

        {error && <p className="enrollment-view__error">{error}</p>}
      </div>
    </div>
  );
}
