import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { ListEmpty, ListError, ListLoading, describeListError } from './ListStates';

/**
 * 列表三态统一组件（#300 验收第 4 条）：
 * 加载态只出骨架、空态才说「没有数据」、错误态必须带错误码与重试。
 */

describe('ListLoading 加载态', () => {
  it('出骨架 + 可读标签，且带 aria-label="列表加载中"', () => {
    const html = renderToStaticMarkup(<ListLoading label="库存流水加载中…" />);

    expect(html).toContain('aria-label="列表加载中"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('库存流水加载中…');
    expect((html.match(/animate-pulse/g) ?? []).length).toBe(3);
  });

  it('rows 可调（详情区域用更少的骨架）', () => {
    const html = renderToStaticMarkup(<ListLoading label="详情加载中…" rows={2} />);
    expect((html.match(/animate-pulse/g) ?? []).length).toBe(2);
  });
});

describe('ListEmpty 空态', () => {
  it('主提示与下一步说明都渲染，不把空态写成错误', () => {
    const html = renderToStaticMarkup(
      <ListEmpty title="暂无采购单。" hint="用右上角「新建采购单」开第一张。" />,
    );

    expect(html).toContain('暂无采购单。');
    expect(html).toContain('用右上角「新建采购单」开第一张。');
    expect(html).not.toContain('rose');
  });
});

describe('ListError 错误态', () => {
  it('ApiError 显示后端文案 + 错误码 + 重试', () => {
    const error = new ApiError({
      code: 'FORBIDDEN',
      message: '缺少 inventory_flow.read 权限',
      status: 403,
      requestId: 'req-123',
    });
    const html = renderToStaticMarkup(
      <ListError title="流水加载失败" error={error} onRetry={() => {}} />,
    );

    expect(html).toContain('流水加载失败：缺少 inventory_flow.read 权限（FORBIDDEN）');
    expect(html).toContain('重试');
    expect(html).toContain('请求号 req-123');
    expect(html).toContain('role="alert"');
  });

  it('自定义 message 时仍单独给出错误码，不丢码', () => {
    const error = new ApiError({ code: 'RATE_LIMITED', message: '太快了', status: 429 });
    const html = renderToStaticMarkup(
      <ListError title="加载失败" error={error} message="请求太频繁，请稍后重试。" />,
    );

    expect(html).toContain('请求太频繁，请稍后重试。');
    expect(html).toContain('错误码 RATE_LIMITED');
  });

  it('非 ApiError 不吞错；未知错误也有兜底文案', () => {
    expect(describeListError('加载失败', new Error('网络不可达'))).toBe(
      '加载失败：网络不可达',
    );
    expect(describeListError('加载失败', undefined)).toBe('加载失败：未知错误');
  });

  it('没有 onRetry 时不画空按钮', () => {
    const html = renderToStaticMarkup(<ListError title="加载失败" />);
    expect(html).not.toContain('重试');
  });
});
