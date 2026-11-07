import type { AUDIT_SOURCES } from './audit.js';

/**
 * HTTP 头契约（D54 §9-4 冻结：`X-Client` 映射审计 `source`；reason 走 `X-Reason` 头，
 * 与 body 解耦，写接口与 AI 调用都必须带）。
 */
export const HEADERS = {
  requestId: 'X-Request-Id',
  client: 'X-Client',
  reason: 'X-Reason',
  idempotencyKey: 'Idempotency-Key',
  ifMatch: 'If-Match',
  etag: 'ETag',
} as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];

const CLIENT_TO_SOURCE: Record<string, AuditSource> = {
  web: 'web',
  cli: 'cli',
  api: 'api',
  mcp: 'mcp',
  job: 'job',
};

/** 未带或未知的 `X-Client` 一律记 `api`（机器直连），不猜来源。 */
export function auditSourceFromClient(client: string | undefined): AuditSource {
  if (!client) return 'api';
  return CLIENT_TO_SOURCE[client.toLowerCase()] ?? 'api';
}

/** 危险动作 + AI 写操作的 reason 校验口径（D51 / D52.1）。 */
export function reasonRequiredFor(kind: 'write' | 'sensitive-read' | 'read' | 'none', actorType: string): boolean {
  if (kind === 'write') return actorType === 'ai' ? true : false;
  return false;
}
