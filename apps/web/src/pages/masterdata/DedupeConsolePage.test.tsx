import type { DedupePair } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { createQueryClient } from '../../api/query';
import { authKeys } from '../auth/auth-api';
import { DedupeConsolePage } from './DedupeConsolePage';
import { dedupeQueryKeys } from './dedupe-api';

/**
 * 去重审核台的首屏渲染测试。
 *
 * 只断言 `renderToStaticMarkup` 能看见的东西（列表内容、四态行、`null` 名字的兜底）：
 * 判定 / 合并 / 撤销判定都要先点按钮、再走 `prompt` + `confirm`，静态渲染测不到；
 * 那几个动作真正会发什么请求，由 `dedupe-api.test.ts` 覆盖。
 * 不为「测到按钮」写一条永远绿的断言——那种测试只会让人误以为流程被覆盖了。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const PAIR_ID = '01a1bf69-545e-7265-b209-ff4f133e169e';

const PAIR: DedupePair = {
  id: PAIR_ID,
  kind: 'customer',
  score: 0.88,
  matchedBy: 'name_phone',
  note: null,
  state: 'pending',
  createdAt: '2026-11-18T01:02:00.000Z',
  left: {
    id: 'c-old',
    name: '张记建材（老）',
    contactPhone: '13800000000',
    specification: null,
  },
  right: {
    id: 'c-new',
    name: '张记建材',
    contactPhone: '13800000000',
    specification: null,
  },
};

/** 档案被物理删除（D93）：`name` 为 null，队列行还在。 */
const DELETED_PAIR: DedupePair = {
  ...PAIR,
  id: 'dp-deleted',
  left: { id: 'gone', name: null, contactPhone: null, specification: null },
};

const SUPPLIER_PAIR: DedupePair = {
  ...PAIR,
  id: 'dp-supplier',
  kind: 'supplier',
  left: { ...PAIR.left, id: 's-old' },
  right: { ...PAIR.right, id: 's-new' },
};

interface TestMe {
  readonly employeeId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly companyIds: readonly string[];
  readonly scope: readonly {
    readonly domain: string;
    readonly actions: readonly string[];
  }[];
}

const FULL: TestMe = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [COMPANY_ID],
  scope: [
    { domain: 'customer', actions: ['read', 'merge'] },
    { domain: 'supplier', actions: ['read', 'merge'] },
    { domain: 'product', actions: ['read'] },
  ],
};

function seedClient(input: {
  readonly me: TestMe;
  readonly pairs: readonly DedupePair[];
}): QueryClient {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(
    // 键必须和页面 `useQuery` 算出来的完全一致：默认状态是 pending、类型不限（undefined）。
    dedupeQueryKeys.list({ companyId: COMPANY_ID, kind: undefined, state: 'pending' }),
    { items: [...input.pairs] },
  );
  return client;
}

function renderPage(client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <DedupeConsolePage />
    </QueryClientProvider>,
  );
}

describe('主数据去重审核台', () => {
  it('列表能看到两侧档案名、相似度与命中依据', () => {
    const html = renderPage(seedClient({ me: FULL, pairs: [PAIR] }));

    expect(html).toContain('主数据去重审核台');
    expect(html).toContain('张记建材（老）');
    expect(html).toContain('张记建材');
    // score 0.88 → 88.00%，页面也写明「越高越像」，别让人当成评分
    expect(html).toContain('88.00%');
    expect(html).toContain('越高越像');
    expect(html).toContain('名称与电话都相同');
  });

  it('name 为 null 显示「档案已删除」而不是空白（D93 物理删除）', () => {
    const html = renderPage(seedClient({ me: FULL, pairs: [DELETED_PAIR] }));

    expect(html).toContain('档案已删除');
  });

  it('有数据时容器与 tbody 都是 filled，三个状态行常驻；数据行只带 r-row', () => {
    const html = renderPage(seedClient({ me: FULL, pairs: [PAIR] }));

    expect(html).toContain('data-state="filled"');
    expect(html).toContain('st-tr st-loading');
    expect(html).toContain('st-tr st-error');
    expect(html).toContain('st-tr st-empty');
    expect(html).toContain('class="r-row"');
    // 数据行带上 st-tr 会被 `tbody > tr.st-tr{display:none}` 整行吃掉
    expect(html).not.toContain('st-tr r-row');
  });

  it('空列表时 data-state 切到 empty，状态行 colSpan 等于表头列数（8 列不塌）', () => {
    const html = renderPage(seedClient({ me: FULL, pairs: [] }));

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('colSpan="8"');
    expect(html).toContain('没有要处理的疑似重复档案');
  });

  it('缺该 kind 的 merge 权限时说清缺哪个权限点，并把按钮置灰', () => {
    const me: TestMe = { ...FULL, scope: [{ domain: 'supplier', actions: ['read'] }] };
    const html = renderPage(seedClient({ me, pairs: [SUPPLIER_PAIR] }));

    expect(html).toContain('需要 supplier.merge 权限');
    expect(html).toContain('disabled');
  });

  it('已合并的行不给任何动作（契约写明 merged 不可回退）', () => {
    const html = renderPage(
      seedClient({ me: FULL, pairs: [{ ...PAIR, state: 'merged' }, SUPPLIER_PAIR] }),
    );

    expect(html).toContain('已合并，不可回退');
    // 合并不可回退，所以「不是同一家 / 撤销判定」都不该出现在这一行。
    // 静态 HTML 无法按行定位，改成数出现次数：只有 supplier 那一行有按钮，merged 行不能贡献。
    expect(html.match(/>不是同一家</g) ?? []).toHaveLength(1);
    // supplier 那行有 merge 权限，按钮仍在，说明上一条不是因为整页没按钮
    expect(html).toContain('>合并<');
  });
});
