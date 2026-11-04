import { AsyncLocalStorage } from 'node:async_hooks';
import { HEADERS } from '@qingdan/contracts';
import { v7 as uuidv7 } from 'uuid';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * X-Request-Id 透传 + AsyncLocalStorage 上下文。
 *
 * 缺省用 UUIDv7（时间有序，D55③），客户端传入的 id 原样保留（截断到 128 字符）。
 * 统一错误体、审计写入都从 `currentRequestId()` / `request.requestId` 取同一个 id。
 */

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

/** 头名真源在契约包（D54 §9-4 冻结）；Node 侧统一小写读取。 */
export const REQUEST_ID_HEADER = HEADERS.requestId.toLowerCase();
/** 回写响应头时用冻结的原名。 */
export const REQUEST_ID_HEADER_OUT = HEADERS.requestId;
export const MAX_REQUEST_ID_LENGTH = 128;

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return uuidv7();
}

/** 当前请求的 id（不在请求上下文内时为 undefined）。 */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** 供错误处理与审计使用：优先 decorator（跨 hook 稳定），回退 Fastify 自带 id。 */
export function requestIdFor(request: FastifyRequest): string {
  return request.requestId || String(request.id);
}

export interface RequestIdOptions {
  /** 缺省 id 生成器（测试可注入固定值）。 */
  readonly factory?: () => string;
}

export function registerRequestId(app: FastifyInstance, options: RequestIdOptions = {}): void {
  const factory = options.factory ?? newRequestId;
  app.decorateRequest('requestId', '');
  app.addHook('onRequest', (request, reply, done) => {
    const raw = request.headers[REQUEST_ID_HEADER];
    const incoming = Array.isArray(raw) ? raw[0] : raw;
    const requestId =
      typeof incoming === 'string' && incoming.trim() !== ''
        ? incoming.trim().slice(0, MAX_REQUEST_ID_LENGTH)
        : factory();

    request.requestId = requestId;
    reply.header(REQUEST_ID_HEADER_OUT, requestId);
    // 让后续 handler / 错误处理 / 审计写入都跑在同一个 ALS 上下文里。
    runWithRequestId(requestId, () => done());
  });
}
