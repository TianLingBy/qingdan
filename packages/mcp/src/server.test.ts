import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { ROUTES, isDangerousOperation, mcpToolName } from '@qingdan/contracts';
import { createServer } from './server.js';
import { buildToolDefinitions, splitToolArguments } from './tools.js';

const tools = buildToolDefinitions(ROUTES);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('工具定义', () => {
  it('工具数 == ROUTES 数，名字 1:1 且唯一', () => {
    expect(tools).toHaveLength(ROUTES.length);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(tools.map((t) => t.name)).toEqual(ROUTES.map((r) => mcpToolName(r)));
  });

  it('inputSchema 都是对象，且带上路径参数/字段', () => {
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    const create = tools.find((t) => t.name === 'qingdan_platform_token_create');
    expect(create?.inputSchema.properties?.name).toBeDefined();
    expect(create?.inputSchema.required).toEqual(expect.arrayContaining(['name', 'employeeId', 'scope']));
    const revoke = tools.find((t) => t.name === 'qingdan_platform_token_revoke');
    expect(revoke?.inputSchema.properties?.id).toEqual({ type: 'string' });
    expect(revoke?.inputSchema.required).toContain('id');
  });

  it('危险动作带 destructiveHint 与审批说明；只读动作 readOnlyHint', () => {
    for (const route of ROUTES) {
      const tool = tools.find((t) => t.name === mcpToolName(route));
      expect(tool?.annotations?.destructiveHint).toBe(isDangerousOperation(route.operationId));
      expect(tool?.annotations?.readOnlyHint).toBe(route.method === 'GET');
      expect(tool?.description).toContain(route.scope);
    }
    const revoke = tools.find((t) => t.name === 'qingdan_platform_token_revoke');
    expect(revoke?.annotations?.destructiveHint).toBe(true);
    expect(revoke?.description).toContain('需人类审批');
  });

  it('参数按名平铺，调用时拆回 path/query/body', () => {
    const create = ROUTES.find((r) => r.operationId === 'platform.token.create');
    const split = splitToolArguments(create!, { name: 'n', employeeId: 'e', scope: [] });
    expect(split.body).toEqual({ name: 'n', employeeId: 'e', scope: [] });
    const revoke = ROUTES.find((r) => r.operationId === 'platform.token.revoke');
    expect(splitToolArguments(revoke!, { id: 'tok-1' }).params).toEqual({ id: 'tok-1' });
  });
});

describe('stdio server（InMemory 传输）', () => {
  it('tools/list 返回全部工具；危险动作被拒；只读动作走 HTTP', async () => {
    const calls: string[] = [];
    const server = createServer({
      baseUrl: 'http://127.0.0.1:3000',
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse(200, { status: 'ok', version: '1.0.0' });
      },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(ROUTES.length);

    const denied = await client.callTool({ name: 'qingdan_platform_token_revoke', arguments: { id: 'tok-1' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain('需人类审批');
    expect(calls).toHaveLength(0);

    const ok = await client.callTool({ name: 'qingdan_platform_health_read', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(calls).toEqual(['http://127.0.0.1:3000/api/v1/health']);

    await client.close();
  });
});
