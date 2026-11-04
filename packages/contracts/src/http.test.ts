import { describe, expect, it } from 'vitest';
import { auditSourceFromClient, HEADERS, reasonRequiredFor } from './http.js';

describe('HTTP 头契约（D54 §9-4）', () => {
  it('头名冻结', () => {
    expect(HEADERS).toEqual({
      requestId: 'X-Request-Id',
      client: 'X-Client',
      reason: 'X-Reason',
      idempotencyKey: 'Idempotency-Key',
      ifMatch: 'If-Match',
      etag: 'ETag',
    });
  });

  it('X-Client → 审计 source；未知或缺失按 api', () => {
    expect(auditSourceFromClient('cli')).toBe('cli');
    expect(auditSourceFromClient('MCP')).toBe('mcp');
    expect(auditSourceFromClient('web')).toBe('web');
    expect(auditSourceFromClient('job')).toBe('job');
    expect(auditSourceFromClient(undefined)).toBe('api');
    expect(auditSourceFromClient('curl')).toBe('api');
  });

  it('AI 写操作必须带 reason（人类写操作不强制）', () => {
    expect(reasonRequiredFor('write', 'ai')).toBe(true);
    expect(reasonRequiredFor('write', 'employee')).toBe(false);
    expect(reasonRequiredFor('sensitive-read', 'ai')).toBe(false);
  });
});
