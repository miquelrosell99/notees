/**
 * BootForm — the boot screens: server URL entry (+ same-host suggestion),
 * initial setup, login (account / API-key tabs), signup, and "Work
 * offline". Pure composition over the useBootFlow state + handlers; the
 * phase gate lives in App.
 */

import type { Dispatch, SetStateAction } from "react";

import { ThemeToggle } from "../ThemeToggle.js";
import { Button } from "../components/ui/Button.js";
import type { Phase } from "./useWorkspaceConnection.js";
import type { BootFlow } from "./useBootFlow.js";

export function BootForm({
  phase,
  error,
  setError,
  setPhase,
  boot,
}: {
  phase: Phase;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  setPhase: Dispatch<SetStateAction<Phase>>;
  boot: BootFlow;
}) {
  const {
    serverUrl,
    setServerUrl,
    email,
    setEmail,
    password,
    setPassword,
    passwordConfirm,
    setPasswordConfirm,
    displayName,
    setDisplayName,
    authTab,
    setAuthTab,
    signupEnabled,
    apiKeyInput,
    setApiKeyInput,
    hint,
    serverSuggestion,
    handleServerSubmit,
    handleServerSuggestion,
    handleSetup,
    handleLogin,
    handleSignup,
    handleApiKeySubmit,
    handleWorkOffline,
  } = boot;
  const isLogin = phase.name === "login";
  const isSignup = phase.name === "signup";
  const isNewAccount = phase.name === "setup" || isSignup;
  return (
    <div className="nt-bootstrap">
      <div className="nt-bootstrap-form nt-card">
        <div className="nt-brand">
          <span className="nt-brand-mark" aria-hidden="true">
            ◈
          </span>
          <h1 className="nt-bootstrap-title">Notees</h1>
        </div>
        {phase.name === "server" && (
          <p className="nt-bootstrap-subtitle">Connect to a Notees sync server — or work offline.</p>
        )}
        {phase.name === "setup" && (
          <p className="nt-bootstrap-subtitle">Initial setup — create the admin account</p>
        )}
        {isSignup && (
          <p className="nt-bootstrap-subtitle">Create an account on this server</p>
        )}
        {isLogin && (
          <div className="nt-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={authTab === "account"}
              className={authTab === "account" ? "nt-tab nt-tab-active" : "nt-tab"}
              onClick={() => {
                setAuthTab("account");
                setError(null);
              }}
            >
              Account
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authTab === "apikey"}
              className={authTab === "apikey" ? "nt-tab nt-tab-active" : "nt-tab"}
              onClick={() => {
                setAuthTab("apikey");
                setError(null);
              }}
            >
              API key
            </button>
          </div>
        )}

        {isLogin && authTab === "apikey" ? (
          <form
            className="nt-form"
            onSubmit={(e) => void handleApiKeySubmit(e)}
          >
            <label className="nt-field">
              <span>Server URL</span>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://notees.example.com"
                required
              />
            </label>
            <label className="nt-field">
              <span>API key</span>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="nk_…"
                autoComplete="off"
                required
              />
            </label>
            <Button type="submit" variant="primary">
              Sign in with key
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setApiKeyInput("");
                setError(null);
                setPhase({ name: "server" });
              }}
            >
              Change server
            </Button>
            {hint !== null && <p className="nt-hint">{hint}</p>}
            {error !== null && <p className="nt-error" role="alert">{error}</p>}
          </form>
        ) : (
          <form
            className="nt-form"
            onSubmit={(e) =>
              void (phase.name === "setup"
                ? handleSetup(e)
                : isSignup
                  ? handleSignup(e)
                  : isLogin
                    ? handleLogin(e)
                    : handleServerSubmit(e))
            }
          >
            <label className="nt-field">
              <span>Server URL</span>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://notees.example.com"
                disabled={phase.name !== "server"}
                required
              />
            </label>
            {phase.name === "setup" && (
              <label className="nt-field">
                <span>Name (optional)</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                />
              </label>
            )}
            {phase.name !== "server" && (
              <>
                <label className="nt-field">
                  <span>Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </label>
                <label className="nt-field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={isNewAccount ? "new-password" : "current-password"}
                    required
                  />
                </label>
              </>
            )}
            {isNewAccount && (
              <label className="nt-field">
                <span>Confirm password</span>
                <input
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            )}
            <Button type="submit" variant="primary">
              {isNewAccount ? "Create account" : isLogin ? "Sign in" : "Continue"}
            </Button>
            {phase.name === "server" && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleWorkOffline()}
              >
                Work offline
              </Button>
            )}
            {isLogin && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEmail("");
                  setPassword("");
                  setError(null);
                  setPhase({ name: "server" });
                }}
              >
                Change server
              </Button>
            )}
            {isLogin && signupEnabled && (
              <p className="nt-hint">
                No account yet?{" "}
                <button
                  type="button"
                  className="nt-link"
                  onClick={() => {
                    setPassword("");
                    setPasswordConfirm("");
                    setError(null);
                    setPhase({ name: "signup" });
                  }}
                >
                  Create one
                </button>
              </p>
            )}
            {isSignup && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPassword("");
                  setPasswordConfirm("");
                  setError(null);
                  setPhase({ name: "login" });
                }}
              >
                Back to sign in
              </Button>
            )}
            {hint !== null && <p className="nt-hint">{hint}</p>}
            {error !== null && <p className="nt-error" role="alert">{error}</p>}
          </form>
        )}
        {serverSuggestion !== null && (
          <div className="nt-server-suggestion">
            <p className="nt-hint">
              This app is usually served by the same machine as the sync
              server — the address below is this origin itself.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleServerSuggestion()}
            >
              Try {serverSuggestion} instead
            </Button>
          </div>
        )}
        <div className="nt-bootstrap-footer">
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
