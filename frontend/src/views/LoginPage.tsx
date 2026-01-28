/**
 * Login page component
 */
import { useState } from 'react';
import './LoginPage.css';
import { useAuthStore } from '@/stores';
import { Button } from '../components/core/Button';
import { TextField } from '../components/core/TextField';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const { login, register, isLoading, error, clearError } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    
    try {
      if (isRegister) {
        await register(username, password);
      } else {
        await login(username, password);
      }
    } catch {
      // Error is handled by store
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Notees</h1>
        <p className="login-subtitle">
          {isRegister ? 'Create your account' : 'Sign in to continue'}
        </p>
        
        <form onSubmit={handleSubmit} className="login-form">
          <TextField
            id="username"
            type="text"
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
            required
            autoComplete="username"
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
          
          {error && <div className="error-message">{error}</div>}
          
          <Button type="submit" variant="primary" fullWidth disabled={isLoading}>
            {isLoading ? 'Loading...' : isRegister ? 'Register' : 'Sign In'}
          </Button>
        </form>
        
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
      </div>
    </div>
  );
}
