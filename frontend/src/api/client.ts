/**
 * API client configuration and base functions.
 * 
 * Uses axios for HTTP requests with automatic auth token handling.
 */
import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getLogger } from '../utils/logger';
import { getAuthToken, clearAuthToken } from '../utils/auth';

const log = getLogger('api');

// Create axios instance with default config
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token and logging
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAuthToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  // Log outgoing requests
  log.debug(`→ ${config.method?.toUpperCase()} ${config.url}`, {
    params: config.params,
    hasBody: !!config.data,
  });
  
  return config;
});

// Response interceptor for error handling and logging
api.interceptors.response.use(
  (response) => {
    // Successful responses are not logged to reduce console noise;
    // errors are logged in the reject handler below.
    return response;
  },
  (error: AxiosError) => {
    const status = error.response?.status;
    const url = error.config?.url;
    const method = error.config?.method?.toUpperCase();
    
    if (status === 401) {
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
    } else if (status && status >= 500) {
      log.error(`Server error: ${status} ${method} ${url}`, error);
    } else if (status && status >= 400) {
      log.warn(`Client error: ${status} ${method} ${url}`, {
        message: error.message,
        data: error.response?.data,
      });
    } else {
      log.error(`Network error: ${method} ${url}`, error);
    }
    
    return Promise.reject(error);
  }
);

export default api;

// Export the axios instance type for use in other modules
export type { AxiosInstance, AxiosError };
