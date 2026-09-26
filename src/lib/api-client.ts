import axios, {
  AxiosError,
  type InternalAxiosRequestConfig,
  type AxiosRequestConfig,
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from 'axios';
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from './auth-storage';
import type { AuthTokens } from './auth-storage';

declare module 'axios' {
  export interface AxiosRequestConfig {
    _retry?: boolean;
    _skipAuthRefresh?: boolean;
  }
}

const DEFAULT_API_BASE_URL = 'https://9ba6-2a05-45c2-5096-8d00-25bd-cfec-69a1-d861.ngrok-free.app';

const configuredBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ??
  DEFAULT_API_BASE_URL
).trim();
const useApiProxy =
  import.meta.env.DEV &&
  configuredBaseUrl.length > 0 &&
  import.meta.env.VITE_API_USE_PROXY !== 'false';
const API_BASE_URL = useApiProxy ? '' : configuredBaseUrl;
const NGROK_BYPASS_HEADER_NAME = 'ngrok-skip-browser-warning';

function isNgrokHost(baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname.endsWith('.ngrok-free.dev') ||
      hostname.endsWith('.ngrok-free.app') ||
      hostname.endsWith('.ngrok.io')
    );
  } catch {
    return false;
  }
}

const shouldAttachNgrokBypassHeader = isNgrokHost(API_BASE_URL);

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
});

const refreshClient = axios.create({
  baseURL: API_BASE_URL,
});

let refreshPromise: Promise<AuthTokens | null> | null = null;
let authFailureHandler: (() => void) | null = null;

function applyCommonRequestHeaders(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  config.headers = config.headers ?? {};
  
  // Only set default Accept if not already specified
  if (!config.headers.Accept) {
    config.headers.Accept = 'application/json';
  }

  if (shouldAttachNgrokBypassHeader) {
    config.headers[NGROK_BYPASS_HEADER_NAME] = 'true';
  }

  return config;
}

function isNgrokInterstitialResponse(
  headers?: AxiosResponseHeaders | RawAxiosResponseHeaders,
): boolean {
  if (!headers) {
    return false;
  }

  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  const ngrokErrorCode = String(headers['ngrok-error-code'] ?? '').toUpperCase();

  return contentType.includes('text/html') && ngrokErrorCode.startsWith('ERR_NGROK_');
}

export function setAuthFailureHandler(handler: (() => void) | null): void {
  authFailureHandler = handler;
}

function notifyAuthFailure(): void {
  authFailureHandler?.();
}

function shouldSkipRefresh(config?: AxiosRequestConfig): boolean {
  if (!config) {
    return true;
  }

  if (config._skipAuthRefresh) {
    return true;
  }

  const url = config.url ?? '';
  return url.includes('/api/auth/login/') || url.includes('/api/auth/refresh/');
}

async function refreshAccessToken(): Promise<AuthTokens | null> {
  const refresh = getRefreshToken();

  if (!refresh) {
    return null;
  }

  const { data } = await refreshClient.post<Partial<AuthTokens>>(
    '/api/auth/refresh/',
    { refresh },
    { _skipAuthRefresh: true },
  );

  const responseData =
    data && typeof data === 'object' && 'data' in data
      ? (data as { data?: Partial<AuthTokens> }).data ?? data
      : data;

  if (
    typeof responseData?.access !== 'string' ||
    responseData.access.length === 0
  ) {
    return null;
  }

  const nextTokens: AuthTokens = {
    access: responseData.access,
    refresh: typeof responseData.refresh === 'string' && responseData.refresh.length > 0
      ? responseData.refresh
      : refresh,
  };

  setTokens(nextTokens);
  return nextTokens;
}

export async function requestTokenRefresh(): Promise<AuthTokens | null> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

apiClient.interceptors.request.use((config) => {
  const nextConfig = applyCommonRequestHeaders(config);
  const token = getAccessToken();

  if (token) {
    nextConfig.headers = nextConfig.headers ?? {};
    nextConfig.headers.Authorization = `Bearer ${token}`;
  }

  return nextConfig;
});

refreshClient.interceptors.request.use((config) => {
  return applyCommonRequestHeaders(config);
});

apiClient.interceptors.response.use(
  (response) => {
    if (isNgrokInterstitialResponse(response.headers)) {
      return Promise.reject(
        new Error('Ngrok interstitial page returned instead of JSON API response.'),
      );
    }

    return response;
  },
  async (error: AxiosError) => {
    const originalConfig = error.config;
    const statusCode = error.response?.status;

    if (
      statusCode !== 401 ||
      !originalConfig ||
      originalConfig._retry ||
      shouldSkipRefresh(originalConfig)
    ) {
      return Promise.reject(error);
    }

    originalConfig._retry = true;

    try {
      const refreshedTokens = await requestTokenRefresh();

      if (!refreshedTokens) {
        clearTokens();
        notifyAuthFailure();
        return Promise.reject(error);
      }

      originalConfig.headers = originalConfig.headers ?? {};
      originalConfig.headers.Authorization = `Bearer ${refreshedTokens.access}`;
      return apiClient(originalConfig);
    } catch (refreshError) {
      clearTokens();
      notifyAuthFailure();
      return Promise.reject(refreshError);
    }
  },
);
