import {
  AppError,
  HEADERS,
  auditSourceFromClient,
  reasonRequiredFor,
  type AuditKind,
  type AuditSource,
} from '@qingdan/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActorType } from '../audit/writer.js';

/**
 * 审计上下文（D54 §9-4 冻结头契约）。
 *
 * - 来源 `source`：只由 `X-Client` 经 `auditSourceFromClient()` 映射，未带/未知 = `api`（不猜）；
 * - 原因 `reason`：读 `X-Reason`，与 body 解耦；写接口与 AI 调用必须带；
 * - `actorType` 由认证层解析后写入（M0 尚无认证，保持 undefined）。
 *
 * reason 闸门已接线但**当前不生效**：preHandler 只在 `request.actorType` 有值时判定，
 * 认证落地后自动生效；在那之前所有端点仍统一 501，不会被本次闸门提前拦成 422。
 */

declare module 'fastify' {
  interface FastifyRequest {
    auditSource: AuditSource;
    auditReason: string | null;
    /** 认证层解析后填；M0 未接认证，保持 undefined。 */
    actorType?: ActorType;
  }
}

const MAX_REASON_LENGTH = 2000;

export interface AuditContext {
  readonly source: AuditSource;
  readonly reason: string | null;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** 从请求头取审计来源与原因（纯函数，便于单测）。 */
export function auditContextFrom(request: FastifyRequest): AuditContext {
  const reasonRaw = headerValue(request, HEADERS.reason);
  const reason =
    typeof reasonRaw === 'string' && reasonRaw.trim() !== ''
      ? reasonRaw.trim().slice(0, MAX_REASON_LENGTH)
      : null;
  return {
    source: auditSourceFromClient(headerValue(request, HEADERS.client)),
    reason,
  };
}

/**
 * reason 口径：`reasonRequiredFor(kind, actorType)` 为真（AI 写操作）但没带 `X-Reason` → 422。
 * 返回 422 而非 403：缺原因是请求不合法（契约 reasonCode `REASON_REQUIRED` → VALIDATION_FAILED）。
 */
export function assertAuditReason(input: {
  readonly kind: AuditKind;
  readonly actorType: ActorType | undefined;
  readonly reason: string | null;
  readonly operationId?: string;
}): void {
  if (!input.actorType) return;
  if (!reasonRequiredFor(input.kind, input.actorType)) return;
  if (input.reason) return;
  throw new AppError('VALIDATION_FAILED', '该操作必须提供 X-Reason（AI 写操作原因必填）', {
    header: HEADERS.reason,
    operationId: input.operationId,
  });
}

export function registerAuditContext(app: FastifyInstance): void {
  app.decorateRequest('auditSource', 'api');
  app.decorateRequest('auditReason', null);

  app.addHook('onRequest', (request, _reply, done) => {
    const { source, reason } = auditContextFrom(request);
    request.auditSource = source;
    request.auditReason = reason;
    done();
  });

  app.addHook('preHandler', (request, _reply, done) => {
    const config = request.routeOptions.config as {
      operationId?: string;
      auditKind?: AuditKind;
    };
    try {
      assertAuditReason({
        kind: config.auditKind ?? 'none',
        actorType: request.actorType,
        reason: request.auditReason,
        operationId: config.operationId,
      });
      done();
    } catch (error) {
      done(error as Error);
    }
  });
}
