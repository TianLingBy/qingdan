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

    // 未知异常：日志留全量（含栈），响应只给稳定错误码。
    request.log.error({ err: error, requestId }, '未处理异常');
    reply.status(500).send(new AppError('INTERNAL_ERROR').toBody(requestId));
  });
}
