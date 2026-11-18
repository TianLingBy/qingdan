import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../api/query.js';
import { SuggestHint } from './SuggestHint.js';

/**
 * 联想提示的「什么时候不该出现」（#374 的 suggest×4）。
 *
 * 这里只测**不该渲染**的情形，不测候选列表 —— 候选要等异步请求回来，
 * SSR 静态渲染拿不到（首屏 `candidates.length === 0`，组件直接返回 null）。
 * 请求形状由 `masterdata-suggest-api.test.ts` 验。
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
