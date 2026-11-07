import { ApiErrorBodySchema, type ApiErrorBody, type HttpMethod } from '@qingdan/contracts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientConfig {
  baseUrl: string;
  token?: string | undefined;
  ifMatch?: string | undefined;
  idempotencyKey?: string | undefined;
  /** 写操作的变更原因（目前只是一层透传，服务端/审计如何取用未定）。 */
  reason?: string | undefined;
}

export interface CallSpec {
  method: HttpMethod;
  path: string;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  data?: unknown;
  error?: ApiErrorBody;
}

/** 拼 URL：路径占位符 `{name}` 用 params 填充（缺失即报错，不发半截请求）。 */
export function buildUrl(baseUrl: string, spec: CallSpec): string {
  const path = spec.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = spec.params?.[name];
    if (value === undefined) throw new Error(`缺少路径参数 ${name}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    if (value === undefined || value === null) continue;
    search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const qs = search.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

/** 薄客户端：只做拼 URL / 带头 / 解析统一错误体（契约第三批 §3）。 */
export async function callApi(
  spec: CallSpec,
  config: ClientConfig,
  fetchImpl: FetchLike = fetch,
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Client': 'cli' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (config.ifMatch) headers['If-Match'] = config.ifMatch;
  if (config.idempotencyKey) headers['Idempotency-Key'] = config.idempotencyKey;
  if (config.reason) headers['X-Reason'] = config.reason;

  const init: RequestInit = { method: spec.method, headers };
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(spec.body);
  }

  const res = await fetchImpl(buildUrl(config.baseUrl, spec), init);
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.ok) return { status: res.status, ok: true, data: parsed };

  const error = ApiErrorBodySchema.safeParse(parsed);
  return {
    status: res.status,
    ok: false,
    data: parsed,
    error: error.success
      ? error.data
      : { code: 'INTERNAL_ERROR', message: text || res.statusText, requestId: 'unknown' },
  };
}
