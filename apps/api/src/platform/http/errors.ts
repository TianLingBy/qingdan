import { AppError } from '@qingdan/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requestIdFor } from './request-id.js';

/**
 * 统一错误处理（契约第三批 §3）：
 *   - `AppError` → 对应 HTTP 状态 + `{ code, message, details?, requestId }`；
 *   - 入参校验/请求体格式错误 → 422 `VALIDATION_FAILED`（details.issues 带字段级信息）；
 *   - 其它未知异常 → 500 `INTERNAL_ERROR`，**只记服务端日志，不把栈/内部信息回给客户端**；
 *   - 未知路由 → 404 `NOT_FOUND`（同统一错误体，不泄露路由表）。
 */

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function validationDetails(error: FastifyError): { issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (Array.isArray(error.validation)) {
    for (const item of error.validation) {
      const record = item as { instancePath?: unknown; message?: unknown };
      issues.push({
        path: typeof record.instancePath === 'string' ? record.instancePath : '',
        message: typeof record.message === 'string' ? record.message : '参数不合法',
      });
    }
  }
  if (issues.length === 0) {
    issues.push({ path: '', message: error.message });
  }
  return { issues };
}

/**
 * 数据库级 D15 触发器违规（migrations/0027）：SQLSTATE 23514 + 消息前缀 `D15:`。
 * 只认这个前缀，避免把其它 check 约束违规误报成 422。
 */
export function isD15Violation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === '23514' &&
    typeof candidate.message === 'string' &&
    candidate.message.startsWith('D15:')
  );
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const body = new AppError('NOT_FOUND', `路由不存在：${request.method} ${request.url}`).toBody(
      requestIdFor(request),
    );
    reply.status(404).send(body);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = requestIdFor(request);

    if (error instanceof AppError) {
      reply.status(error.status).send(error.toBody(requestId));
      return;
    }

    if (error.validation) {
      reply
        .status(422)
        .send(
          new AppError('VALIDATION_FAILED', '参数校验失败', validationDetails(error)).toBody(requestId),
        );
      return;
    }

    // 请求体格式/媒体类型等客户端错误：Fastify 标了 4xx，统一映射成 422，仍走统一错误体。
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      reply
        .status(422)
        .send(new AppError('VALIDATION_FAILED', '请求格式不合法').toBody(requestId));
      return;
    }

    // 数据库级业务约束（D15 触发器）：业务层已被 repo 拦下，这里兜住绕过业务层的入口。
    if (isD15Violation(error)) {
      request.log.warn({ err: error, requestId }, '数据库级 D15 校验拦截');
      reply
        .status(422)
        .send(new AppError('VALIDATION_FAILED', '商品不属于该采购单所在公司').toBody(requestId));
      return;
    }

    // 未知异常：日志留全量（含栈），响应只给稳定错误码。
    request.log.error({ err: error, requestId }, '未处理异常');
    reply.status(500).send(new AppError('INTERNAL_ERROR').toBody(requestId));
  });
}
