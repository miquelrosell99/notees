/**
 * API client configuration and base functions.
 *
 * Uses ky (a tiny fetch wrapper) for HTTP requests with automatic auth token handling.
 * Provides an axios-compatible response interface so existing API modules don't need changes.
 */
import ky, { HTTPError, type Options } from 'ky';
import { getLogger } from '../utils/logger';
import { getAuthToken, clearAuthToken, setAuthToken, getApiKey } from '../utils/auth';

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
    headers: Headers;
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

const kyClient = ky.create({
  prefixUrl: '/api',
  timeout: 30000,
  hooks: {
    beforeRequest: [
      (request) => {
        const token = getAuthToken();
        if (token) {
          request.headers.set('Authorization', `Bearer ${token}`);
        }

        const apiKey = getApiKey();
        if (apiKey) {
          request.headers.set('X-API-Key', apiKey);
        }

        // Log outgoing requests
        log.debug(`→ ${request.method} ${request.url}`, {
          hasBody: !!request.body,
        });
      },
    ],
    beforeError: [
      async (error) => {
        const { response } = error;
        const url = error.request?.url ?? '';
        const method = error.request?.method?.toUpperCase() ?? '';

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
              let data: unknown;
              try {
                data = await response.clone().json();
              } catch {
                try {
                  data = await response.clone().text();
                } catch {
                  data = undefined;
                }
              }
              log.warn(`Client error: ${response.status} ${method} ${url}`, {
                message: error.message,
                data,
              });
            }
          }
        } else {
          log.error(`Network error: ${method} ${url}`, error);
        }

        return error;
      },
    ],
  },
});

async function exec<T = any>(method: string, url: string, options?: RequestOptions, isRetry = false): Promise<{ data: T; headers: Headers }> {
  // ky rejects inputs starting with '/' when prefixUrl is set; strip it
  const cleanUrl = url.startsWith('/') ? url.slice(1) : url;
  const kyOptions: Options = {};

  if (options?.params) {
    kyOptions.searchParams = options.params as Record<string, string | number | boolean>;
  }

  if (options?.headers) {
    kyOptions.headers = options.headers;
  }

  if (options?.timeout !== undefined) {
    kyOptions.timeout = options.timeout === false ? false : options.timeout;
  }

  if (options?.data !== undefined && options.data !== null) {
    if (options.data instanceof FormData || options.data instanceof Blob) {
      kyOptions.body = options.data;
    } else {
      kyOptions.json = options.data;
    }
  }

  try {
    let resp: Response;
    switch (method) {
      case 'GET':
        resp = await kyClient.get(cleanUrl, kyOptions);
        break;
      case 'POST':
        resp = await kyClient.post(cleanUrl, kyOptions);
        break;
      case 'PUT':
        resp = await kyClient.put(cleanUrl, kyOptions);
        break;
      case 'DELETE':
        resp = await kyClient.delete(cleanUrl, kyOptions);
        break;
      case 'PATCH':
        resp = await kyClient.patch(cleanUrl, kyOptions);
        break;
      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    let data: unknown;
    if (options?.responseType === 'blob') {
      data = await resp.blob();
    } else if (options?.responseType === 'text') {
      data = await resp.text();
    } else {
      data = await resp.json();
    }

    return { data: data as T, headers: resp.headers };
  } catch (err) {
    if (err instanceof HTTPError && err.response.status === 401 && !isRetry && !url.includes('/auth/refresh')) {
      // Attempt silent token refresh
      const newToken = await refreshAccessToken();
      if (newToken) {
        // Retry the original request with the new token
        return exec<T>(method, url, options, true);
      }
      // Refresh failed — handle auth failure
      handleAuthFailure();
    }

    if (err instanceof HTTPError) {
      let data: unknown;
      try {
        data = await err.response.clone().json();
      } catch {
        try {
          data = await err.response.clone().text();
        } catch {
          data = undefined;
        }
      }

      const apiErr = new ApiError(err.message);
      apiErr.response = {
        status: err.response.status,
        data,
        headers: err.response.headers,
      };
      apiErr.config = { url, method };
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
