import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';
import { ROUTES } from './routes.js';
import { ENTITIES } from './entities.js';
import { DOMAIN_KEYS } from './domains.js';

const doc = buildOpenApiDocument(ROUTES);
const serialized = JSON.stringify(doc);

describe('OpenAPI 3.1 发射', () => {
  it('版本与方言', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('路径与操作数与注册表一致（双向覆盖，防漂移）', () => {
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBe(new Set(ROUTES.map((r) => r.path)).size);
    let ops = 0;
    for (const p of Object.values(doc.paths)) ops += Object.keys(p).length;
    expect(ops).toBe(ROUTES.length);
    for (const r of ROUTES) {
      expect(doc.paths[r.path]?.[r.method.toLowerCase()], `${r.method} ${r.path}`).toBeTruthy();
    }
  });

  it('每个操作都带 x-scope / x-audit / x-ai-policy / x-mcp-tool（D54 缺口 10）', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
        expect(op['x-scope'], `${method} ${path}`).toBeTypeOf('string');
        expect(op['x-audit'], `${method} ${path}`).toHaveProperty('kind');
        expect(op['x-ai-policy'], `${method} ${path}`).toHaveProperty('policy');
        expect(op['x-mcp-tool'], `${method} ${path}`).toMatch(/^qingdan_[a-z0-9_]+$/);
      }
    }
  });

  it('components.schemas 与注册表实体一一对应（D57 ①）', () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual(ENTITIES.map((e) => e.name).sort());
    expect(serialized).not.toContain('$defs');
    for (const name of Object.keys(doc.components.schemas)) expect(serialized).toContain(`#/components/schemas/${name}`);
  });

  it('引用全部指向已存在的 schema', () => {
    const refs = [...serialized.matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(doc.components.schemas[ref], ref).toBeTruthy();
  });

  it('认证与 tag', () => {
    expect(doc.components.securitySchemes.cookieAuth).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'qingdan_session' });
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    const tags = (doc.tags as Array<{ name: string }>).map((t) => t.name);
    expect(tags).toEqual(DOMAIN_KEYS);
    expect(tags).toHaveLength(23);
  });

  it('公开端点不要求认证', () => {
    const health = doc.paths['/api/v1/health']!.get as Record<string, unknown>;
    expect(health.security).toEqual([]);
    const audit = doc.paths['/api/v1/audit-logs']!.get as Record<string, unknown>;
    expect(audit.security).toHaveLength(2);
  });
});
