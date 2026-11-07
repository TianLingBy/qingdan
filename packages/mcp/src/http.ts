import { ApiErrorBodySchema, type ApiErrorBody, type HttpMethod } from '@qingdan/contracts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpHttpConfig {
  baseUrl: string;
  token?: string | undefined;
}

export interface McpCallSpec {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
}

export interface McpHttpResult {
  status: number;
  ok: boolean;
  data?: unknown;
  error?: ApiErrorBody;
}

/** MCP 侧的极薄客户端（只走 /api/v1 HTTP，禁止直连 DB）。 */
export async function callApi(
  spec: McpCallSpec,
  config: McpHttpConfig,
  fetchImpl: FetchLike = fetch,
): Promise<McpHttpResult> {
  const path = spec.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name: string) =>
    encodeURIComponent(spec.params[name] ?? ''),
  );
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(spec.query)) {
    if (value === undefined || value === null) continue;
    search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const qs = search.toString();
  const url = `${config.baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = { Accept: 'application/json', 'X-Client': 'mcp' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const init: RequestInit = { method: spec.method, headers };
  if (spec.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(spec.body);
  }

  const res = await fetchImpl(url, init);
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
