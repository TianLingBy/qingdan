import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ListPager, pageWindow } from './ListPager';

/**
 * v3.0 列表分页（`.tf` 页脚右侧）。
 *
 * 这一组用例守的是「页码条画对」而不是「画出来」：
 * 折叠规则、当前页高亮、首末页禁用、条数选择器都得有断言，
 * 否则下次谁把 `pageWindow` 改成 `.slice(0, 7)` 也没人发现。
 */

describe('pageWindow 折叠规则', () => {
  it('7 页以内全画，不出现省略号', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('超过 7 页折成「首 … 当前±1 … 末」', () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, 'dots', 12]);
    expect(pageWindow(5, 12)).toEqual([1, 'dots', 4, 5, 6, 'dots', 12]);
    expect(pageWindow(12, 12)).toEqual([1, 'dots', 11, 12]);
  });

  it('当前页永远在窗口里，头和尾不会同时缺', () => {
    for (const page of [1, 2, 3, 6, 9, 11, 12]) {
      expect(pageWindow(page, 12)).toContain(page);
    }
  });
});

describe('ListPager 渲染', () => {
  const base = { page: 1, totalPages: 3, pageSize: 20, onPage: () => {} };

  it('首 / 上 / 下 / 末四个方向键都有可读名字，第一页时前两个禁用', () => {
    const html = renderToStaticMarkup(<ListPager {...base} />);

    for (const label of ['第一页', '上一页', '下一页', '最后一页']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    // 在第 1 页：第一页 / 上一页 disabled，下一页 / 最后一页可点
    expect(html).toMatch(/aria-label="第一页"[^>]*disabled/);
    expect(html).toMatch(/aria-label="上一页"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="下一页"[^>]*disabled/);
  });

  it('当前页按钮带 on 与 aria-current，不靠颜色单独表意', () => {
    const html = renderToStaticMarkup(<ListPager {...base} page={2} />);

    expect(html).toContain('class="on"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="第 2 页"');
  });

  it('省略号是 span 不是按钮（点了没反应等于坏）', () => {
    const html = renderToStaticMarkup(<ListPager {...base} page={6} totalPages={12} />);

    expect(html).toContain('class="dots"');
    expect(html).toContain('…');
    expect(html).not.toContain('aria-label="第 dots 页"');
  });

  it('只传 onPageSize 时才画条数下拉，选中项跟随 pageSize', () => {
    const without = renderToStaticMarkup(<ListPager {...base} />);
    expect(without).not.toContain('每页条数');

    const withSize = renderToStaticMarkup(
      <ListPager {...base} pageSize={50} onPageSize={() => {}} />,
    );
    expect(withSize).toContain('aria-label="每页条数"');
    expect(withSize).toContain('<option value="50" selected="">50 条/页</option>');
  });

  it('单页列表也保留条数选择器（想一屏看完的人要能改回来）', () => {
    const html = renderToStaticMarkup(
      <ListPager {...base} page={1} totalPages={1} onPageSize={() => {}} />,
    );

    expect(html).toContain('aria-label="每页条数"');
    expect(html).toMatch(/aria-label="下一页"[^>]*disabled/);
  });
});
