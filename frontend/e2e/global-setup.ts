/**
 * Playwright global setup for Notees E2E tests.
 *
 * Creates a fresh test user via the admin API (using the auto-created admin
 * account from ADMIN_PASSWORD) and persists an authenticated browser context
 * so tests start already logged in.
 */

import { chromium, type FullConfig } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_EMAIL = 'admin@notees.local';
const TEST_USER_PASSWORD = 'E2eTestP@ssw0rd!2026';
const STORAGE_STATE_PATH = join(__dirname, '.auth', 'user.json');
const ALPINE_CHROMIUM_PATH = '/usr/lib/chromium/chromium';

function testUserEmail(): string {
  const ts = Date.now();
  return `e2e-tester-${ts}@notees.local`;
}

function loadEnv(): Record<string, string> {
  const envPaths = [join(__dirname, '..', '..', '.env'), join(__dirname, '..', '.env')];
  for (const path of envPaths) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const env: Record<string, string> = {};
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\"/g, '"');
        } else if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1);
        }
        env[key] = value;
      }
      return env;
    }
  }
  return process.env as Record<string, string>;
}

async function apiLogin(baseURL: string, email: string, password: string, retries = 3): Promise<string[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(`${baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, remember_me: true }),
    });
    if (resp.ok) {
      return resp.headers.getSetCookie?.() ?? (resp.headers.get('set-cookie')?.split(', ') ?? []);
    }
    if (resp.status === 429 && attempt < retries) {
      const delay = 10_000 * (attempt + 1);
      console.log(`Login rate-limited for ${email}, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const body = await resp.text().catch(() => '');
    throw new Error(`Login failed for ${email}: ${resp.status} ${body}`);
  }
  throw new Error(`Login failed for ${email}: exhausted retries`);
}

async function adminCreateUser(baseURL: string, cookies: string[], email: string): Promise<void> {
  const resp = await fetch(`${baseURL}/api/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.join('; '),
    },
    body: JSON.stringify({
      email,
      password: TEST_USER_PASSWORD,
      name: 'E2E Tester',
      role: 'user',
      active: true,
    }),
  });
  if (!resp.ok && resp.status !== 409) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Failed to create test user: ${resp.status} ${body}`);
  }
}

async function fetchMe(baseURL: string, cookies: string[]) {
  const resp = await fetch(`${baseURL}/api/auth/me`, {
    headers: { Cookie: cookies.join('; ') },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch /api/auth/me: ${resp.status}`);
  }
  return resp.json();
}

async function setUserSetting(
  baseURL: string,
  cookies: string[],
  key: string,
  value: unknown,
): Promise<void> {
  const resp = await fetch(`${baseURL}/api/auth/me/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.join('; '),
    },
    body: JSON.stringify({ value }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Failed to set setting ${key}: ${resp.status} ${body}`);
  }
}

async function completeEnrollment(baseURL: string, cookies: string[]): Promise<void> {
  await setUserSetting(baseURL, cookies, 'theme', 'system');
  await setUserSetting(baseURL, cookies, 'date_format', 'iso');
  await setUserSetting(baseURL, cookies, 'enrollment_completed', true);
}

async function createWorkspace(baseURL: string, cookies: string[], name: string) {
  const resp = await fetch(`${baseURL}/api/workspaces/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.join('; '),
    },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Failed to create workspace: ${resp.status} ${body}`);
  }
  return resp.json();
}

async function refreshSession(baseURL: string, cookies: string[]): Promise<string[]> {
  const resp = await fetch(`${baseURL}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookies.join('; ') },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Failed to refresh session: ${resp.status} ${body}`);
  }
  return resp.headers.getSetCookie?.() ?? (resp.headers.get('set-cookie')?.split(', ') ?? []);
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  const env = loadEnv();
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is not set; E2E global setup cannot authenticate as admin.');
  }

  // 1. Authenticate as admin and create a dedicated test user.
  const adminCookies = await apiLogin(baseURL, ADMIN_EMAIL, adminPassword);
  const email = testUserEmail();
  await adminCreateUser(baseURL, adminCookies, email);

  // 2. Authenticate as the test user, complete enrollment, and create a workspace via API.
  const testCookies = await apiLogin(baseURL, email, TEST_USER_PASSWORD);
  const me = await fetchMe(baseURL, testCookies);
  await completeEnrollment(baseURL, testCookies);
  await createWorkspace(baseURL, testCookies, 'E2E Workspace');

  // 3. Refresh the session so the persisted cookies have the maximum remaining
  //    lifetime. This prevents access-token expiry from breaking later tests.
  const freshCookies = await refreshSession(baseURL, testCookies);

  // 4. Seed the browser storage state: HTTPOnly cookies + persisted auth user.
  const browser = await chromium.launch({
    executablePath: existsSync(ALPINE_CHROMIUM_PATH) ? ALPINE_CHROMIUM_PATH : undefined,
  });
  const context = await browser.newContext();
  await context.addCookies(
    freshCookies.map((cookie) => {
      const parsed: Record<string, string> = {};
      const [kv, ...attrs] = cookie.split(';').map((s) => s.trim());
      const [name, value] = kv.split('=');
      parsed.name = name;
      parsed.value = value ?? '';
      for (const attr of attrs) {
        const [k, v] = attr.split('=');
        parsed[k.toLowerCase()] = v ?? 'true';
      }
      return {
        name: parsed.name,
        value: parsed.value,
        domain: parsed.domain ?? 'localhost',
        path: parsed.path ?? '/',
        httpOnly: parsed.httponly === 'true',
        secure: parsed.secure === 'true',
        sameSite: (parsed.samesite
          ? (parsed.samesite.charAt(0).toUpperCase() + parsed.samesite.slice(1).toLowerCase()) as 'Strict' | 'Lax' | 'None'
          : 'Lax'),
        expires: parsed.expires && parsed.expires !== 'Session' ? new Date(parsed.expires).getTime() / 1000 : undefined,
      };
    }),
  );

  const page = await context.newPage();
  await page.goto(`${baseURL}/workspaces`);
  await page.evaluate((user) => {
    localStorage.setItem('user', JSON.stringify(user));
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user }, version: 0 }),
    );
  }, me);

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
