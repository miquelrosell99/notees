/**
 * API client configuration and base functions.
 *
 * Uses ky (a tiny fetch wrapper) for HTTP requests with automatic auth token handling.
 * Provides an axios-compatible response interface so existing API modules don't need changes.
 */
import ky, { HTTPError, type Options } from 'ky';
import { getLogger } from '../utils/logger';
import { getAuthToken, clearAuthToken, getApiKey } from '../utils/auth';

const log = getLogger('api');

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
  headers: {
    'Content-Type': 'application/json',
  },
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
            log.warn(`Authentication failed: ${method} ${url}`);

            // Token expired or invalid - clear auth data
            clearAuthToken();
            localStorage.removeItem('auth-storage'); // Clear persisted auth store

            // Dispatch custom event to notify app of auth failure
            window.dispatchEvent(new CustomEvent('auth:unauthorized'));

            // Only redirect if not already on auth page
            if (window.location.pathname !== '/auth') {
              log.info('Redirecting to auth page');
              window.location.href = '/auth';
            }
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

async function exec<T = any>(method: string, url: string, options?: RequestOptions): Promise<{ data: T; headers: Headers }> {
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
        resp = await kyClient.get(url, kyOptions);
        break;
      case 'POST':
        resp = await kyClient.post(url, kyOptions);
        break;
      case 'PUT':
        resp = await kyClient.put(url, kyOptions);
        break;
      case 'DELETE':
        resp = await kyClient.delete(url, kyOptions);
        break;
      case 'PATCH':
        resp = await kyClient.patch(url, kyOptions);
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
