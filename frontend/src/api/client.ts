/**
 * API client configuration and base functions.
 *
 * Uses axios for HTTP requests with automatic auth token handling.
 */
import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { getLogger } from '@/utils/logger';
import { getAuthToken, clearAuthToken, setAuthToken, getApiKey } from '@/utils/auth';

const log = getLogger('api');

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const resp = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!resp.ok) {
      throw new Error(`Refresh failed: ${resp.status}`);
    }
    const data = await resp.json();
    if (data.access_token) {
      setAuthToken(data.access_token);
      return data.access_token;
    }
    throw new Error('No access_token in refresh response');
  } catch (err) {
    log.error('Token refresh failed', err);
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
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

function handleAuthFailure() {
  clearAuthToken();
  localStorage.removeItem('auth-storage');
  window.dispatchEvent(new CustomEvent('auth:unauthorized'));
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
});

axiosClient.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }

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
      log.error(`Network error: ${method} ${url}`, error);
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
      // Attempt silent token refresh
      const newToken = await refreshAccessToken();
      if (newToken) {
        // Retry the original request with the new token
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
