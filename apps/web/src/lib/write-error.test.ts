import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import {
  describeWriteError,
  isStaleVersionError,
  recoverFromStaleVersion,
  staleVersionRecoveredText,
} from './write-error';

/**
 * 写失败口径（单据五页共用）。
 *
 * 这里锁三条规矩：
 * - 只有「按旧版本写」才算 stale（409 VERSION_CONFLICT / 428），别把 409 的幂等冲突也算进来；
 * - 已知码给人话，未知码保留服务端 message + code（便于贴给后端定位）；
 * - 取不到最新单据时返回 null，**不要冒泡异常**——报错叠加会让用户更懵。
 */
const apiError = (status: number, code: string, message = '服务端原文') =>
  new ApiError({ status, code, message });

describe('isStaleVersionError', () => {
  it('409 VERSION_CONFLICT 与 428 都算页面数据过期', () => {
    expect(isStaleVersionError(apiError(409, 'VERSION_CONFLICT'))).toBe(true);
    expect(isStaleVersionError(apiError(428, 'PRECONDITION_REQUIRED'))).toBe(true);
  });

  it('409 的幂等冲突不是版本问题', () => {
    expect(isStaleVersionError(apiError(409, 'IDEMPOTENCY_CONFLICT'))).toBe(false);
  });

  it('非 ApiError（网络中断 / 前端自己 throw）不算', () => {
    expect(isStaleVersionError(new Error('fetch failed'))).toBe(false);
    expect(isStaleVersionError(null)).toBe(false);
  });
});

describe('describeWriteError', () => {
  it('版本冲突给人话，提示重新读取而不是让用户干瞪眼', () => {
    expect(describeWriteError(apiError(409, 'VERSION_CONFLICT'))).toContain('已被别人改过');
  });

  it('缺版本头、无权限、未实现各有自己的话术', () => {
    expect(describeWriteError(apiError(428, 'PRECONDITION_REQUIRED'))).toContain('页面数据已过期');
    expect(describeWriteError(apiError(403, 'FORBIDDEN'))).toContain('没有该操作权限');
    expect(describeWriteError(apiError(501, 'NOT_IMPLEMENTED'))).toContain('501');
  });

  it('未知码保留服务端 message 与 code', () => {
    expect(describeWriteError(apiError(422, 'VALIDATION_FAILED', '数量必须大于 0'))).toBe(
      '数量必须大于 0（VALIDATION_FAILED）',
    );
  });

  it('非 ApiError 用自身 message，空 message 用兜底文案', () => {
    expect(describeWriteError(new Error('网络中断'))).toBe('网络中断');
    expect(describeWriteError(new Error(''))).toBe('操作失败，请稍后重试');
    expect(describeWriteError(undefined)).toBe('操作失败，请稍后重试');
  });
});

describe('recoverFromStaleVersion', () => {
  const detail = { id: 'o1', version: 7 };

  it('版本冲突 + 有单据 id → 取回最新版本', async () => {
    const load = vi.fn().mockResolvedValue(detail);
    await expect(
      recoverFromStaleVersion(apiError(409, 'VERSION_CONFLICT'), 'o1', load),
    ).resolves.toEqual(detail);
    expect(load).toHaveBeenCalledWith('o1');
  });

  it('不是版本冲突 → 不去打请求（避免无谓流量）', async () => {
    const load = vi.fn().mockResolvedValue(detail);
    await expect(recoverFromStaleVersion(apiError(403, 'FORBIDDEN'), 'o1', load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('没有单据 id（新建流程）→ 不处理', async () => {
    const load = vi.fn().mockResolvedValue(detail);
    await expect(
      recoverFromStaleVersion(apiError(409, 'VERSION_CONFLICT'), null, load),
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('取最新也失败 → 返回 null，不把二次错误抛出去', async () => {
    const load = vi.fn().mockRejectedValue(new Error('又是 403'));
    await expect(
      recoverFromStaleVersion(apiError(409, 'VERSION_CONFLICT'), 'o1', load),
    ).resolves.toBeNull();
  });
});

describe('staleVersionRecoveredText', () => {
  it('带上最新版本号，并说明「内容还在」', () => {
    expect(staleVersionRecoveredText(8)).toBe(
      '这张单已被别人改过，已同步到最新版本 v8；你填的内容还在，请核对后再次保存。',
    );
  });
});
