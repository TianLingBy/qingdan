import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { isDangerousOperation, mcpPolicy, mcpToolName, type RouteDef } from '@qingdan/contracts';

export interface BuildToolOptions {
  /** 租户是否允许危险动作「走审批」；默认 false（MCP 一律拒绝）。 */
  tenantAllowsApproval?: boolean;
}

/** zod 4 的 schema 实例自带 toJSONSchema；这里不直接依赖 zod 包（契约包已持有它）。 */
interface ZodJsonSchema {
  toJSONSchema(options?: { io?: 'input' | 'output' }): Record<string, unknown>;
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] as string);
}

/** 取输入侧 JSON Schema，去掉 `$schema`（MCP inputSchema 只要对象体）。 */
function jsonObject(schema: unknown): Record<string, unknown> {
  if (!schema) return {};
  const { $schema: _drop, ...rest } = (schema as ZodJsonSchema).toJSONSchema({ io: 'input' });
  return rest;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return (schema.properties as Record<string, unknown> | undefined) ?? {};
}

function requiredOf(schema: Record<string, unknown>): string[] {
  return (schema.required as string[] | undefined) ?? [];
}

export interface ToolArgumentNames {
  path: string[];
  body: string[];
  query: string[];
}

/** 工具入参是按名平铺的：路径参数 + body 字段 + query 字段（当前注册表无重名）。 */
export function toolArgumentNames(route: RouteDef): ToolArgumentNames {
  return {
    path: pathParamNames(route.path),
    body: Object.keys(propertiesOf(jsonObject(route.request?.body))),
    query: Object.keys(propertiesOf(jsonObject(route.request?.query))),
  };
}

/** 把工具调用参数拆回 REST 形态（path / query / body）。 */
export function splitToolArguments(
  route: RouteDef,
  args: Record<string, unknown>,
): { params: Record<string, string>; query: Record<string, unknown>; body: Record<string, unknown> | undefined } {
  const names = toolArgumentNames(route);
  const params: Record<string, string> = {};
  for (const name of names.path) params[name] = String(args[name] ?? '');
  const query: Record<string, unknown> = {};
  for (const name of names.query) if (args[name] !== undefined) query[name] = args[name];
  const body: Record<string, unknown> = {};
  for (const name of names.body) if (args[name] !== undefined) body[name] = args[name];
  return { params, query, body: Object.keys(body).length > 0 ? body : undefined };
}

function inputSchemaFor(route: RouteDef): Tool['inputSchema'] {
  const body = jsonObject(route.request?.body);
  const query = jsonObject(route.request?.query);
  const properties: Record<string, unknown> = { ...propertiesOf(body), ...propertiesOf(query) };
  const required = new Set<string>([...requiredOf(body), ...requiredOf(query)]);
  for (const name of pathParamNames(route.path)) {
    properties[name] = { type: 'string' };
    required.add(name);
  }
  return {
    ...body,
    type: 'object',
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
  } as Tool['inputSchema'];
}

function describe(route: RouteDef, policy: ReturnType<typeof mcpPolicy>): string {
  const lines = [
    route.summary,
    `${route.method} ${route.path} · scope=${route.scope}`,
    route.ai.reasonRequired ? '必须携带 reason（记审计）' : null,
    policy === 'forbid'
      ? '危险动作：MCP 默认拒绝，需人类审批后手动执行'
      : policy === 'require-approval'
        ? '危险动作：需人类审批后才可执行'
        : null,
    route.requiresIfMatch ? '需要 If-Match（乐观锁）' : null,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

/** ROUTES → MCP 工具数组（名字与 operationId 1:1，见 mcpToolName）。 */
export function buildToolDefinitions(routes: readonly RouteDef[], opts: BuildToolOptions = {}): Tool[] {
  const tenantAllowsApproval = opts.tenantAllowsApproval ?? false;
  return routes.map((route) => {
    const policy = mcpPolicy(route, tenantAllowsApproval);
    return {
      name: mcpToolName(route),
      description: describe(route, policy),
      inputSchema: inputSchemaFor(route),
      annotations: {
        readOnlyHint: route.method === 'GET',
        destructiveHint: isDangerousOperation(route.operationId),
        idempotentHint: route.method === 'GET' || route.idempotent,
      },
    };
  });
}
