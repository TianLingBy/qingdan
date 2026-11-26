import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../api/query.js';
import { SuggestHint } from './SuggestHint.js';

/**
 * 联想提示的渲染口径（#374 的 suggest×4、#431 必做点 7 接入开单草档）。
 *
 * 两组用例：
 * 1. **什么时候不该出现** —— 没名字 / 一个字 / 没 `companyId` / 已选中。
 * 2. **命中候选时长什么样** —— 用预置查询缓存的 `QueryClient` 直接喂候选，
 *    不发请求，所以 SSR 静态渲染也能断言按钮文案与相似度。
 *
 * 为什么「不该渲染」值得专门测：这个组件嵌在开单表单的输入框下面，
 * 多渲染一个空盒子就会把用户正在填的字段往下推一截，边打字边跳。
 * 契约要求最少 2 个字、`companyId` 必传，两条任一不满足都必须彻底不渲染。
 */

const COMPANY_ID = '01900000-0000-7000-8000-000000000002';

function render(props: Parameters<typeof SuggestHint>[0]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={createQueryClient()}>
      <SuggestHint {...props} />
    </QueryClientProvider>,
  );
}

/** 命中候选：把结果先塞进缓存（键与组件内部完全一致），静态渲染就能读到。 */
function renderWithCandidates(
  kind: Parameters<typeof SuggestHint>[0]['kind'],
  name: string,
  candidates: readonly { id: string; name: string; score: number; reason: string }[],
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['masterdata', 'suggest', kind, COMPANY_ID, name.trim()], { candidates });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SuggestHint kind={kind} name={name} companyId={COMPANY_ID} onPick={() => {}} />
    </QueryClientProvider>,
  );
}

describe('SuggestHint 不该出现的时候', () => {
  it('名字为空 —— 一个字都没打', () => {
    const html = render({ kind: 'customer', name: '', companyId: COMPANY_ID, onPick: () => {} });
    expect(html).toBe('');
  });

  it('只有空白 —— trim 后为空', () => {
    const html = render({
      kind: 'customer',
      name: '   ',
      companyId: COMPANY_ID,
      onPick: () => {},
    });
    expect(html).toBe('');
  });

  it('只有一个字 —— 契约要求最少 2 个字，单字查等于枚举本公司全部张姓客户', () => {
    const html = render({
      kind: 'customer',
      name: '张',
      companyId: COMPANY_ID,
      onPick: () => {},
    });
    expect(html).toBe('');
  });

  it('有名字但没有 companyId —— 宁可不提示，也不能查错公司', () => {
    const html = render({
      kind: 'customer',
      name: '张记建材',
      companyId: '',
      onPick: () => {},
    });
    expect(html).toBe('');
  });

  it('enabled:false —— 已经选过了就不再提示', () => {
    const html = render({
      kind: 'customer',
      name: '张记建材',
      companyId: COMPANY_ID,
      onPick: () => {},
      enabled: false,
    });
    expect(html).toBe('');
  });
});

describe('SuggestHint 命中候选时', () => {
  it('列出名称、理由与相似度（点一下就用，别新建重复档案）', () => {
    const html = renderWithCandidates('customer', '张记', [
      { id: 'c1', name: '张记建材', score: 0.82, reason: '名称高度相似' },
    ]);
    expect(html).toContain('已有相似档案');
    expect(html).toContain('张记建材');
    expect(html).toContain('名称高度相似 · 82%');
  });

  it('没有候选就什么都不渲染（不画空态，不推挤表单）', () => {
    const html = renderWithCandidates('supplier', '宏发', []);
    expect(html).toBe('');
  });

  it('四个域共用同一套渲染：supplier / processor / product 各走一遍', () => {
    for (const kind of ['supplier', 'processor', 'product'] as const) {
      const html = renderWithCandidates(kind, '宏发', [
        { id: 'x1', name: '宏发五金', score: 1, reason: '名称完全相同' },
      ]);
      expect(html).toContain('宏发五金');
      expect(html).toContain('名称完全相同 · 100%');
    }
  });
});
