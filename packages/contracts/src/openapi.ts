import { z } from 'zod';
import type { RouteDef } from './registry.js';
import { DOMAINS, DOMAIN_KEYS } from './domains.js';
import { ENTITIES } from './entities.js';
import { ApiErrorBodySchema } from './errors.js';
import { mcpToolName } from './mcp-map.js';

type Json = Record<string, unknown>;

export interface OpenApiDocument extends Json {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  paths: Record<string, Json>;
  components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> };
}

export const CONTRACT_VERSION = '1.0.0';

/**
 * 递归收集 $defs 并去掉 $schema（D57 ①：注册 id 导出的引用要重写为 components.schemas）。
 *
 * zod v4 对被 globalRegistry 登记过的 schema 会把根发射成 `{ $ref: '#/$defs/Product' }`：
 * - 写 `components.schemas` 时必须展开（否则 Product 变成指向自己的自引用）；
 * - 路由里的响应/请求体则保留根 `$ref`，由 rewriteRefs 改写成 components.schemas 引用。
 */
function toJsonSchema(schema: z.ZodType, hoisted: Map<string, Json>, expandRoot = false): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Json;
  const { $schema: _ignored, $defs, ...rest } = out as Json & { $defs?: Record<string, Json> };
  if ($defs) {
    for (const [k, v] of Object.entries($defs)) {
      if (!hoisted.has(k)) hoisted.set(k, v as Json);
    }
  }
  if (expandRoot) {
    const rootRef = rest.$ref;
    const name = typeof rootRef === 'string' ? /^#\/(?:\$)?defs\/(.+)$/.exec(rootRef)?.[1] : undefined;
    const target = name && $defs ? $defs[name] : undefined;
    if (target) {
      const { $ref: _rootRef, ...siblings } = rest;
      return { ...(target as Json), ...siblings };
    }
  }
  return rest;
}

/** 把 `#/$defs/<Name>` 引用改写成 `#/components/schemas/<Name>`。 */
function rewriteRefs(doc: unknown): unknown {
  return JSON.parse(JSON.stringify(doc).replace(/"#\/(?:\$)?defs\//g, '"#/components/schemas/'));
}

function pathParameters(path: string): Json[] {
  return [...path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function queryParameters(query: z.ZodType, hoisted: Map<string, Json>): Json[] {
  const json = toJsonSchema(query, hoisted);
  const properties = (json.properties ?? {}) as Record<string, Json>;
  const required = (json.required ?? []) as string[];
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.includes(name),
    schema,
  }));
}

export function buildOpenApiDocument(routes: readonly RouteDef[]): OpenApiDocument {
  const hoisted = new Map<string, Json>();
  const schemas: Record<string, Json> = {};

  for (const entity of ENTITIES) {
    schemas[entity.name] = toJsonSchema(entity.schema, hoisted, true);
  }
  schemas.ApiErrorBody ??= toJsonSchema(ApiErrorBodySchema, hoisted, true);

  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const parameters = [
      ...pathParameters(route.path),
      ...(route.request?.query ? queryParameters(route.request.query, hoisted) : []),
    ];
    const responses: Json = {};
    const successStatus = route.response?.status ?? (route.method === 'POST' ? 201 : 200);
    responses[String(successStatus)] = route.response
      ? {
          description: '成功',
          content: { 'application/json': { schema: toJsonSchema(route.response.schema, hoisted) } },
        }
      : { description: '成功' };
    responses.default = {
      description: '错误（统一错误体）',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } } },
    };

    const operation: Json = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.domain],
      security: route.publicAccess ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters,
      responses,
      'x-scope': route.scope,
      'x-module': route.module,
      'x-audit': { kind: route.audit.kind, required: route.audit.required },
      'x-ai-policy': { policy: route.ai.policy, reasonRequired: route.ai.reasonRequired },
      'x-mcp-tool': mcpToolName(route),
    };
    if (route.idempotent) operation['x-idempotent'] = true;
    if (route.requiresIfMatch) operation['x-requires-if-match'] = true;
    if (route.dryRun) operation['x-dry-run'] = true;
    if (route.request?.body) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(route.request.body, hoisted) } },
      };
    }

    const bucket = (paths[route.path] ??= {} as Json) as Json;
    bucket[route.method.toLowerCase()] = operation;
  }

  for (const [name, schema] of hoisted) {
    schemas[name] ??= schema;
  }

  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: '轻单 API',
      version: CONTRACT_VERSION,
      description: '接口真源由 packages/contracts 的 Zod 注册表发射（D52：OpenAPI 3.1，Web/CLI/MCP 同源）。',
    },
    servers: [{ url: '/', description: '相对部署根；路径已含 /api/v1 前缀' }],
    tags: DOMAIN_KEYS.map((key) => ({ name: key, description: DOMAINS[key] })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'qingdan_session' },
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      },
    },
  } as OpenApiDocument;

  return rewriteRefs(doc) as OpenApiDocument;
}
