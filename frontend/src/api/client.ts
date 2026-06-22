/**
 * API client configuration and base functions.
 *
 * Uses axios for HTTP requests with automatic auth token handling.
 */
import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { getLogger } from '@/utils/logger';
import { clearUserData, getApiKey } from '@/utils/auth';
import { useConnectionStore } from '@/stores/connectionStore';

const log = getLogger('api');

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Decode the exp claim from a JWT without verifying the signature.
 * The backend still validates the signature on every request; this is only
 * used to schedule a proactive refresh before the cookie expires.
 */
export function getTokenExpiry(accessToken: string): number | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = JSON.parse(json) as { exp?: number };
    return decoded.exp ?? null;
  } catch {
    return null;
  }
}

/**
 * Schedule a proactive refresh shortly before the access token expires.
 * Keeps the dev session alive without waiting for a 401.
 */
export function scheduleProactiveRefresh(accessToken: string): void {
  cancelProactiveRefresh();
  const exp = getTokenExpiry(accessToken);
  if (!exp) return;

  const expiresAt = exp * 1000;
  const refreshAt = expiresAt - Date.now() - 60_000; // 1 minute before expiry

  if (refreshAt <= 0) {
    // Token is already expiring; refresh immediately.
    refreshAccessToken().catch((err) => {
      log.error('Immediate proactive refresh failed', err);
    });
    return;
  }

  proactiveRefreshTimer = setTimeout(() => {
    refreshAccessToken().catch((err) => {
      log.error('Proactive refresh failed', err);
    });
  }, refreshAt);
}

/**
 * Cancel any pending proactive refresh timer.
 */
export function cancelProactiveRefresh(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

async function doRefresh(): Promise<boolean> {
  try {
    // The backend sets the access token as an HTTPOnly cookie; the frontend
    // just needs to make the request with credentials included. The response
    // body also contains the new access token so we can schedule the next
    // proactive refresh.
    const resp = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      throw new Error(`Refresh failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { access_token?: string };
    if (data.access_token) {
      scheduleProactiveRefresh(data.access_token);
    }
    return true;
  } catch (err) {
    log.error('Token refresh failed', err);
    return false;
  }
}

async function refreshAccessToken(): Promise<boolean> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }
  isRefreshing = true;
  refreshPromise = doRefresh().finally(() => {
    isRefreshing = false;
    refreshPromise = null;
  });
  return refreshPromise;
}

const AUTH_LOGOUT_KEY = 'auth:logout';

function handleAuthFailure() {
  clearUserData();
  localStorage.removeItem('auth-storage');
  // Notify other tabs that this session has ended.
  try {
    localStorage.setItem(AUTH_LOGOUT_KEY, Date.now().toString());
  } catch {
    // Ignore storage errors (e.g., private mode).
  }
  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  // This module is not a React component, so we fall back to a full-page
  // redirect. React-router-aware components should prefer useNavigate().
  if (window.location.pathname !== '/auth') {
    log.info('Redirecting to auth page');
    window.location.href = '/auth';
  }
}

export class ApiError extends Error {
  response?: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
  config?: {
    url: string;
    method: string;
  };
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseType?: 'json' | 'blob' | 'text';
  data?: unknown;
  timeout?: number | false;
}

const axiosClient = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
});

axiosClient.interceptors.request.use((config) => {
  // Access token is sent automatically as an HTTPOnly cookie.
  // Only attach the API key header when one has been configured.
  const apiKey = getApiKey();
  if (apiKey) {
    config.headers.set('X-API-Key', apiKey);
  }

  // Log outgoing requests
  log.debug(`→ ${config.method?.toUpperCase()} ${config.url}`, {
    hasBody: !!config.data,
  });

  return config;
});

axiosClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const { response } = error;
    const url = error.config?.url ?? '';
    const method = error.config?.method?.toUpperCase() ?? '';

    if (response) {
      if (response.status === 401) {
        // Don't clear auth here — the exec function will attempt refresh first.
        // Only log so we can trace the initial 401.
        log.warn(`Authentication challenge: ${method} ${url}`);
      } else if (response.status === 502 || response.status === 503) {
        // Backend or upstream proxy is unavailable (e.g. Postgres recovering).
        log.error(`Server unavailable: ${response.status} ${method} ${url}`, error);
        useConnectionStore.getState().markUnhealthy(`${response.status} ${method} ${url}`);
      } else if (response.status >= 500) {
        log.error(`Server error: ${response.status} ${method} ${url}`, error);
      } else if (response.status >= 400) {
        // 404s are often expected fallback behavior (e.g. RouterSync UUID resolution)
        if (response.status === 404) {
          log.debug(`Client error: ${response.status} ${method} ${url}`, {
            message: error.message,
          });
        } else {
          log.warn(`Client error: ${response.status} ${method} ${url}`, {
            message: error.message,
            data: response.data,
          });
        }
      }
    } else {
      // No response means the request never reached the backend (network error,
      // CORS, browser offline, or proxy down).
      log.error(`Network error: ${method} ${url}`, error);
      useConnectionStore.getState().markUnhealthy(`network error ${method} ${url}`);
    }

    return Promise.reject(error);
  }
);

async function exec<T = any>(
  method: string,
  url: string,
  options?: RequestOptions,
  isRetry = false
): Promise<{ data: T; headers: Record<string, string> }> {
  const axiosOptions: AxiosRequestConfig = {
    method,
    url,
    params: options?.params,
    headers: options?.headers,
    responseType: options?.responseType ?? 'json',
  };

  if (options?.timeout !== undefined) {
    axiosOptions.timeout = options.timeout === false ? 0 : options.timeout;
  }

  if (options?.data !== undefined && options.data !== null) {
    axiosOptions.data = options.data;
  }

  try {
    const resp = await axiosClient.request<T>(axiosOptions);

    return { data: resp.data, headers: resp.headers as Record<string, string> };
  } catch (err) {
    if (
      axios.isAxiosError(err) &&
      err.response?.status === 401 &&
      !isRetry &&
      !url.includes('/auth/refresh')
    ) {
      // Attempt silent token refresh; the backend will set a new access cookie
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        // Retry the original request; the new cookie is sent automatically
        return exec<T>(method, url, options, true);
      }
      // Refresh failed — handle auth failure
      handleAuthFailure();
    }

    if (axios.isAxiosError(err) && err.response) {
      const apiErr = new ApiError(err.message);
      apiErr.response = {
        status: err.response.status,
        data: err.response.data,
        headers: err.response.headers as Record<string, string>,
      };
      apiErr.config = {
        url: err.config?.url ?? url,
        method: err.config?.method?.toUpperCase() ?? method,
      };
      throw apiErr;
    }
    throw err;
  }
}

const api = {
  get: <T = any>(url: string, options?: RequestOptions) => exec<T>('GET', url, options),
  post: <T = any>(url: string, data?: unknown, options?: Omit<RequestOptions, 'data'>) =>
    exec<T>('POST', url, { ...options, data }),
  put: <T = any>(url: string, data?: unknown, options?: Omit<RequestOptions, 'data'>) =>
    exec<T>('PUT', url, { ...options, data }),
  delete: <T = any>(url: string, options?: RequestOptions) => exec<T>('DELETE', url, options),
  patch: <T = any>(url: string, data?: unknown, options?: Omit<RequestOptions, 'data'>) =>
    exec<T>('PATCH', url, { ...options, data }),
};

export default api;
