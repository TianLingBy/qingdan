import { Command } from 'commander';
import { ROUTES, type RouteDef } from '@qingdan/contracts';
import { exitCodeForFailure } from './exit.js';
import { callApi, type FetchLike } from './http.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
export const DEFAULT_TOKEN_ENV = 'QINGDAN_TOKEN';

export interface CliDeps {
  fetch?: FetchLike;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

/** `{id}` / `{employeeId}` → 参数名，按出现顺序（与位置参数一一对应）。 */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] as string);
}

/**
 * 动作名：默认取 operationId 末段（`platform.auth.login` → `login`）。
 * 末段在同一功能域内撞名时（如 api_integration 的 health.read / openapi.read / token.read），
 * 整个域统一改用末两段 `-` 连接（health-read / openapi-read / token-read），保证域内命名一致且全局唯一。
 */
export function buildActionNames(routes: readonly RouteDef[]): string[] {
  const clashes = new Set<string>();
  const seen = new Map<string, number>();
  for (const route of routes) {
    const last = route.operationId.split('.').at(-1) as string;
    const key = `${route.domain}/${last}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) clashes.add(route.domain);
  }
  return routes.map((route) => {
    const parts = route.operationId.split('.');
    return clashes.has(route.domain) ? parts.slice(-2).join('-') : (parts.at(-1) as string);
  });
}

function describeRoute(route: RouteDef): string {
  const flags = [
    `${route.method} ${route.path}`,
    `scope=${route.scope}`,
    route.audit.required ? '记审计' : null,
    route.requiresIfMatch ? '需 --if-match' : null,
    route.ai.policy === 'forbid' ? 'AI 禁止' : null,
  ].filter((flag): flag is string => flag !== null);
  return `${route.summary}\n${flags.join(' · ')}`;
}

/** 用法错误（参数 JSON 解析失败等）→ 退出码 2。 */
class UsageError extends Error {}

function parseJsonArg(raw: unknown, flag: string): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new UsageError(`${flag} 必须是合法 JSON`);
  }
}

/**
 * 按注册表生成 `qingdan <domain> <action>` 两级命令树。
 * domain 用 route.domain 原值；每条命令的位置参数 = 路径参数（按出现顺序），
 * body 走 `--data <json>`，query 走 `--query <json>`。
 */
export function buildCommandTree(program: Command, deps: CliDeps = {}): Command {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const setExitCode = deps.setExitCode ?? ((code: number) => void (process.exitCode = code));

  const actions = buildActionNames(ROUTES);
  const groups = new Map<string, Command>();
  const leaves: string[] = [];

  program
    .name('qingdan')
    .description('轻单 CLI（命令由 packages/contracts 注册表生成）')
    .option('--base-url <url>', 'API 根地址', DEFAULT_BASE_URL)
    .option('--token <token>', `Bearer token（缺省读 $${DEFAULT_TOKEN_ENV}）`)
    .option('--json', '只输出 JSON')
    .option('--dry-run', '预演（仅注册表标了 dryRun 的端点生效）')
    .option('--reason <reason>', '变更原因（写审计）')
    .option('--if-match <etag>', 'If-Match（乐观锁）')
    .option('--idempotency-key <key>', 'Idempotency-Key');

  ROUTES.forEach((route, index) => {
    let group = groups.get(route.domain);
    if (!group) {
      group = program.command(route.domain).description(`功能域 ${route.domain}`);
      groups.set(route.domain, group);
    }
    const action = actions[index] as string;
    const names = pathParamNames(route.path);
    const command = group.command(action).description(describeRoute(route));
    for (const name of names) command.argument(`<${name}>`);
    if (route.request?.body) command.option('--data <json>', '请求体 JSON');
    if (route.request?.query) command.option('--query <json>', 'query JSON');
    leaves.push(`qingdan ${route.domain} ${action}${names.map((n) => ` <${n}>`).join('')}`);

    command.action(async (...raw: unknown[]) => {
      const cmd = raw.at(-1) as Command;
      const local = (raw.at(-2) ?? {}) as Record<string, unknown>;
      const positional = raw.slice(0, -2).map(String);
      const globals = cmd.optsWithGlobals() as Record<string, unknown>;
      try {
        const params: Record<string, string> = {};
        names.forEach((name, i) => {
          params[name] = positional[i] as string;
        });
        const query: Record<string, unknown> =
          globals.dryRun && route.dryRun ? { dryRun: true } : {};
        if (local.query !== undefined) Object.assign(query, parseJsonArg(local.query, '--query'));
        const body = local.data !== undefined ? parseJsonArg(local.data, '--data') : undefined;

        const result = await callApi(
          { method: route.method, path: route.path, params, query, body },
          {
            baseUrl: (globals.baseUrl as string) ?? DEFAULT_BASE_URL,
            token: (globals.token as string | undefined) ?? process.env[DEFAULT_TOKEN_ENV],
            ifMatch: globals.ifMatch as string | undefined,
            idempotencyKey: globals.idempotencyKey as string | undefined,
            reason: globals.reason as string | undefined,
          },
          deps.fetch,
        );

        if (result.ok) {
          const payload = JSON.stringify(result.data ?? null, null, 2);
          out(globals.json ? payload : `HTTP ${result.status}\n${payload}`);
          return;
        }
        if (globals.json) out(JSON.stringify(result.error ?? { status: result.status }, null, 2));
        err(`${result.error?.code ?? 'ERROR'}: ${result.error?.message ?? `HTTP ${result.status}`}`);
        setExitCode(exitCodeForFailure(result.status, result.error?.code));
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        setExitCode(error instanceof UsageError ? 2 : 1);
      }
    });
  });

  program.addHelpText('after', `\n命令（由注册表生成，共 ${leaves.length} 条）：\n${leaves.join('\n')}`);
  return program;
}
