/**
 * 轻单 Web API 客户端（/api/v1 薄封装）
 *
 * 约定（D52 API-first）：Web 只是 `/api/v1` 的客户端，业务逻辑一律在服务层；
 * 错误体为统一结构 `{ code, message, details, requestId }`（见接口契约第三批 §通用 API 约定）。
 */

/** 统一错误体（服务端返回；字段缺失时由客户端兜底）。 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details ?? null;
    this.requestId = input.requestId ?? null;
  }
}

export type QueryPrimitive = string | number | boolean | null | undefined;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** 写操作的幂等键（D54）；有值才发送。 */
  idempotencyKey?: string;
  /** 写操作的原因说明（AI / 危险动作必须带，D52）。 */
  reason?: string;
}

export interface ApiClientOptions {
  /** 默认 `import.meta.env.VITE_API_BASE ?? '/api/v1'` */
  baseUrl?: string;
  /** 取当前会话 token（暂无登录态，返回 null 即不发送 Authorization）。 */
  getToken?: () => string | null | undefined;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
  /** 测试注入用；默认 crypto.randomUUID() */
  newRequestId?: () => string;
}

export const DEFAULT_API_BASE_URL = '/api/v1';

function resolveDefaultBaseUrl(): string {
  const fromEnv = (import.meta.env as ImportMetaEnv | undefined)?.VITE_API_BASE;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : DEFAULT_API_BASE_URL;
}

/** 默认请求 id 生成器：优先 crypto.randomUUID（Chromium 111 已支持），退化到时间戳+随机数。 */
export function defaultRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 拼接 baseUrl 与 path（不做 URL 规范化，保持可断言、可预测）。 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rest = path.replace(/^\/+/, '');
  if (base.length === 0) {
    return `/${rest}`;
  }
  if (rest.length === 0) {
    return base;
  }
  return `${base}/${rest}`;
}

function appendQuery(url: string, query?: Readonly<Record<string, QueryValue>>): string {
  if (!query) {
    return url;
  }
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values as readonly QueryPrimitive[]) {
      if (value === undefined || value === null) {
        continue;
      }
      params.append(key, String(value));
    }
  }
  const search = params.toString();
  if (search.length === 0) {
    return url;
  }
  return url.includes('?') ? `${url}&${search}` : `${url}?${search}`;
}

/** 完整请求 URL（baseUrl + path + query）。测试直接断言这个函数。 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, QueryValue>>,
): string {
  return appendQuery(joinUrl(baseUrl, path), query);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 解析统一错误体 {code,message,details,requestId}；字段缺失或体不是 JSON 时兜底，
 * 保证调用方永远拿到 ApiError 而不是 raw Response。
 */
export function parseApiErrorBody(
  payload: unknown,
  status: number,
  fallbackRequestId?: string | null,
): ApiError {
  if (isRecord(payload) && typeof payload.code === 'string' && typeof payload.message === 'string') {
    return new ApiError({
      code: payload.code,
      message: payload.message,
      status,
      details: payload.details,
      requestId: typeof payload.requestId === 'string' ? payload.requestId : (fallbackRequestId ?? null),
    });
  }
  return new ApiError({
    code: 'UNEXPECTED_RESPONSE',
    message: `请求失败（HTTP ${status}）`,
    status,
    details: payload ?? null,
    requestId: fallbackRequestId ?? null,
  });
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly getToken: () => string | null | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly newRequestId: () => string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? resolveDefaultBaseUrl();
    this.getToken = options.getToken ?? (() => null);
    this.fetchImpl = options.fetchImpl;
    this.newRequestId = options.newRequestId ?? defaultRequestId;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body, headers, signal, idempotencyKey, reason } = options;
    const url = buildRequestUrl(this.baseUrl, path, query);
    const requestId = this.newRequestId();

    const finalHeaders: Record<string, string> = {
      Accept: 'application/json',
      'X-Request-Id': requestId,
    };
    if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    const token = this.getToken();
    if (token) {
      finalHeaders.Authorization = `Bearer ${token}`;
    }
    if (idempotencyKey) {
      finalHeaders['Idempotency-Key'] = idempotencyKey;
    }
    if (reason) {
      finalHeaders['X-Reason'] = reason;
    }
    Object.assign(finalHeaders, headers ?? {});

    const doFetch = this.fetchImpl ?? fetch;
    // 网络层失败（断网 / abort）不是统一错误体，原样抛出保持可辨识
    const response = await doFetch(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const payload = await readPayload(response);
      throw parseApiErrorBody(payload, response.status, response.headers.get('x-request-id') ?? requestId);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await readPayload(response)) as T;
  }

  get<T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<ApiRequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}

/** 应用默认客户端（登录态接入后由 AuthProvider 替换 getToken）。 */
export const apiClient = new ApiClient();
