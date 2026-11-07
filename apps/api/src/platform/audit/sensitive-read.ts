import { allowsScope, type ScopeMatrix } from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/client.js';
import { requestIdFor } from '../http/request-id.js';
import { recordAudit } from './writer.js';

/** 权限域（与 `ScopeMatrix` 的 domain 枚举同源，避免手写字面量漂移）。 */
export type AuditDomain = ScopeMatrix[number]['domain'];

export interface SensitiveReadInput {
  readonly request: FastifyRequest;
  readonly principal: Principal;
  /** 功能域（看价权限所在域），如 `settlement`。 */
  readonly domain: AuditDomain;
  /** 触发审计的 operationId，便于回溯是哪条端点看的金额。 */
  readonly operationId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly companyId?: string | null;
}

/**
 * 「查看敏感金额」审计（D51① / D27 / D78）。
 *
 * 只有**真的会看到金额**的读取才记：没有 `<domain>.view_price` 时响应已被脱敏，
 * 不产生本日志（「与 D27 同口径」，D54②）。日志 `action` 固定 `amount.detail`
 * （`SENSITIVE_READS` 成员），`objectType`/`objectId` 指向被查看的单据，
 * `changes.operationId` 区分具体端点；`result='success'`，读失败不在这里记
 * （由统一失败钩子负责）。
 *
 * 读路径没有业务事务，因此用 `recordAudit`（独立事务 + outbox 搬运），不吞异常。
 */
export async function recordAmountDetailRead(
  db: Database,
  input: SensitiveReadInput,
): Promise<void> {
  if (!allowsScope(input.principal.scope, input.domain, 'view_price')) return;
  const { request, principal } = input;
  await recordAudit(db, {
    tenantId: principal.tenantId,
    companyId: input.companyId ?? null,
    actorType: principal.actorType,
    actorId: principal.actorId,
    credentialId: principal.credentialId,
    source: request.auditSource,
    action: 'amount.detail',
    objectType: input.objectType,
    objectId: input.objectId,
    changeSummary: { operationId: input.operationId, domain: input.domain },
    result: 'success',
    requestId: requestIdFor(request),
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    reason: request.auditReason,
  });
}
