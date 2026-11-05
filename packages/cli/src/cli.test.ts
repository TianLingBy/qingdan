import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '@qingdan/contracts';
import { buildActionNames, buildCommandTree } from './cli.js';
import { exitCodeForFailure } from './exit.js';
import { buildUrl, callApi, type FetchLike } from './http.js';

function leafNames(program: Command): string[] {
  return program.commands.flatMap((domain) => domain.commands.map((cmd) => `${domain.name()} ${cmd.name()}`));
}

function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Bad Gateway',
    text: async () => text,
  } as unknown as Response;
}

describe('命令树', () => {
  it('命令数 == ROUTES 数，且两级名唯一', () => {
    const program = buildCommandTree(new Command());
    const names = leafNames(program);
    expect(names).toHaveLength(ROUTES.length);
    expect(new Set(names).size).toBe(ROUTES.length);
  });

  it('动作名默认取末段；域内撞名时整域改用末两段', () => {
    const actions = buildActionNames(ROUTES);
    const byId = new Map(ROUTES.map((route, i) => [route.operationId, actions[i]]));
    expect(byId.get('platform.auth.login')).toBe('login');
    expect(byId.get('platform.audit.read')).toBe('read');
    // permission 域内 permission.update 与 position.update 撞名 → 整域改用末两段（旧命令改名，见报告）。
    expect(byId.get('platform.permission.update')).toBe('permission-update');
    expect(byId.get('platform.position.list')).toBe('position-list');
    expect(byId.get('platform.position.create')).toBe('position-create');
    expect(byId.get('platform.position.update')).toBe('position-update');
    expect(byId.get('platform.position.delete')).toBe('position-delete');
    // company 域内无撞名 → 保持末段。
    expect(byId.get('platform.company.list')).toBe('list');
    expect(byId.get('platform.company.create')).toBe('create');
    expect(byId.get('platform.company.update')).toBe('update');
    // api_integration 域内三条 read → 全部两段
    expect(byId.get('platform.health.read')).toBe('health-read');
    expect(byId.get('platform.openapi.read')).toBe('openapi-read');
    expect(byId.get('platform.token.read')).toBe('token-read');
    expect(byId.get('platform.token.create')).toBe('token-create');
  });

  it('路径参数是位置参数，body/query 走 --data/--query', () => {
    const program = buildCommandTree(new Command());
    const token = program.commands.find((c) => c.name() === 'api_integration')?.commands.find((c) => c.name() === 'token-revoke');
    expect(token?.registeredArguments.map((a) => a.name())).toEqual(['id']);
    const create = program.commands.find((c) => c.name() === 'api_integration')?.commands.find((c) => c.name() === 'token-create');
    expect(create?.options.map((o) => o.long)).toContain('--data');
  });
});

describe('退出码映射', () => {
  const cases: [number, number][] = [
    [401, 3],
    [403, 3],
    [404, 4],
    [409, 5],
    [422, 4],
    [428, 4],
    [429, 1],
    [500, 1],
  ];
  it.each(cases)('HTTP %i → 退出码 %i', (status, expected) => {
    expect(exitCodeForFailure(status)).toBe(expected);
  });

  it('错误码优先于状态码；网络错误/未知异常 → 1', () => {
    expect(exitCodeForFailure(409, 'IDEMPOTENCY_CONFLICT')).toBe(5);
    expect(exitCodeForFailure(503, 'UNAUTHENTICATED')).toBe(3);
    expect(exitCodeForFailure()).toBe(1);
    expect(exitCodeForFailure(418)).toBe(1);
    expect(exitCodeForFailure(200, 'NOT_A_CODE')).toBe(1);
  });
});

describe('URL 与错误体', () => {
  it('拼 URL：去尾斜杠、填路径参数、带 query、跳过空值', () => {
    const url = buildUrl('http://127.0.0.1:3000/', {
      method: 'GET',
      path: '/api/v1/employees/{employeeId}/permissions',
      params: { employeeId: 'e 1' },
      query: { limit: 10, cursor: undefined, nested: { a: 1 } },
    });
    expect(url).toBe('http://127.0.0.1:3000/api/v1/employees/e%201/permissions?limit=10&nested=%7B%22a%22%3A1%7D');
  });

  it('错误体按 ApiErrorBody 解析，解析不出时兜底 INTERNAL_ERROR', async () => {
    const failing: FetchLike = async () =>
      jsonResponse(409, { code: 'IDEMPOTENCY_CONFLICT', message: '同一 key 不同体', requestId: 'r1' });
    const conflict = await callApi({ method: 'POST', path: '/api/v1/auth/login', body: {} }, { baseUrl: 'http://x' }, failing);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.status).toBe(409);

    const html: FetchLike = async () => textResponse(502, '<html>bad gateway</html>');
    const fallback = await callApi({ method: 'GET', path: '/api/v1/health' }, { baseUrl: 'http://x' }, html);
    expect(fallback.error?.code).toBe('INTERNAL_ERROR');
    expect(fallback.error?.message).toContain('bad gateway');
  });

  it('请求头带 Authorization / Idempotency-Key / If-Match / X-Client，响应成功直接返回体', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { status: 'ok', version: '1.0.0' });
    };
    const result = await callApi(
      { method: 'GET', path: '/api/v1/health', query: { probe: 'cli' } },
      { baseUrl: 'http://127.0.0.1:3000', token: 't', ifMatch: '"3"', idempotencyKey: 'k1' },
      fake,
    );
    expect(result.data).toEqual({ status: 'ok', version: '1.0.0' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/api/v1/health?probe=cli');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t');
    expect(headers['If-Match']).toBe('"3"');
    expect(headers['Idempotency-Key']).toBe('k1');
    expect(headers['X-Client']).toBe('cli');
  });

  it('命令执行失败时按错误码设置退出码（428 → 4）', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    const codes: number[] = [];
    const program = buildCommandTree(new Command(), {
      fetch: async () => jsonResponse(428, { code: 'PRECONDITION_REQUIRED', message: '缺少 If-Match', requestId: 'r2' }),
      stdout: (line) => out.push(line),
      stderr: (line) => errs.push(line),
      setExitCode: (code) => codes.push(code),
    });
    await program.parseAsync(['node', 'qingdan', 'permission', 'permission-update', 'emp-1', '--data', '{"overrides":[]}']);
    expect(codes).toEqual([4]);
    expect(errs.join('\n')).toContain('PRECONDITION_REQUIRED');
  });

  it('危险命令成功时输出结果且不设退出码', async () => {
    const out: string[] = [];
    const program = buildCommandTree(new Command(), {
      fetch: async () => jsonResponse(204, null),
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      setExitCode: () => undefined,
    });
    await program.parseAsync(['node', 'qingdan', 'api_integration', 'token-revoke', 'tok-1', '--json']);
    expect(out.join('')).toContain('null');
  });
});
