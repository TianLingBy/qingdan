import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ROUTES, mcpPolicy, mcpToolName } from '@qingdan/contracts';
import { callApi, type FetchLike } from './http.js';
import { buildToolDefinitions, splitToolArguments } from './tools.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

export interface McpServerDeps {
  fetch?: FetchLike;
  baseUrl?: string;
  token?: string | undefined;
  /** 租户是否放开「危险动作走审批」；默认 false → 直接拒绝。 */
  tenantAllowsApproval?: boolean;
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

export function createServer(deps: McpServerDeps = {}): Server {
  const config = {
    baseUrl: deps.baseUrl ?? process.env.QINGDAN_BASE_URL ?? DEFAULT_BASE_URL,
    token: deps.token ?? process.env.QINGDAN_TOKEN,
  };
  const allowApproval = deps.tenantAllowsApproval ?? process.env.QINGDAN_TENANT_ALLOWS_APPROVAL === 'true';
  const tools = buildToolDefinitions(ROUTES, { tenantAllowsApproval: allowApproval });
  const byName = new Map(ROUTES.map((route) => [mcpToolName(route), route]));

  const server = new Server(
    { name: 'qingdan-mcp', version: '0.0.0' },
    { capabilities: { tools: {} }, instructions: '轻单 MCP：工具由 /api/v1 契约注册表生成；危险动作默认禁止 AI 执行。' },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const route = byName.get(request.params.name);
    if (!route) return textResult(`未注册的工具：${request.params.name}`, true);

    // 危险动作：AI 不得执行，审批只能由人类完成（D52.1 / D54 ⑥）。
    if (mcpPolicy(route, allowApproval) !== 'allow') {
      return textResult(
        `${route.operationId} 是危险动作，需人类审批后由人在 Web/CLI 执行（MCP 不代为审批）。`,
        true,
      );
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { params, query, body } = splitToolArguments(route, args);
    try {
      const result = await callApi(
        { method: route.method, path: route.path, params, query, body },
        config,
        deps.fetch,
      );
      if (result.ok) return textResult(JSON.stringify(result.data ?? null, null, 2));
      return textResult(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? `HTTP ${result.status}`}`, true);
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  return server;
}

/** stdio 启动；诊断信息只能写 stderr，stdout 是协议流。 */
export async function runStdioServer(deps: McpServerDeps = {}): Promise<Server> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // ASCII 诊断串：Windows 控制台按 GBK 解码时中文会乱码，这里不例外。
  process.stderr.write(`qingdan-mcp: stdio ready (${ROUTES.length} tools, base=${deps.baseUrl ?? process.env.QINGDAN_BASE_URL ?? DEFAULT_BASE_URL})\n`);
  return server;
}
