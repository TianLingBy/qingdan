import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon, iconPath } from './Icon';

/**
 * v3.0 图标组件（#443 第 0 步）。
 *
 * 数量断言写 **23**：`design/v3.0/四态与组件对照-给repo.md` §五 里
 * 同时给出 name + path 的只有 23 枚（issue 正文与 `设计说明.md` 都写「24 枚」，
 * 但表格实际 23 行；第 24 枚候选 `search` 在 #445 待拍板）。
 * 梁海俊已在 #443 评论注明「先不要按 24 写测试」，这里按 23 落地；
 * #445 取 24 后把这条改成 24 并补 path 即可。
 */
describe('Icon 图标组件', () => {
  it('清单里有 23 枚且没有重名', () => {
    expect(ICON_NAMES).toHaveLength(23);
    expect(new Set(ICON_NAMES).size).toBe(23);
  });

  it('每一枚都有非空 path，且都从绝对坐标起笔', () => {
    for (const name of ICON_NAMES) {
      const d = iconPath(name);
      expect(d.length).toBeGreaterThan(0);
      // 稿子的 path 全部以 M 开头；出现别的起笔多半是抄串行了
      expect(d.startsWith('M')).toBe(true);
    }
  });

  it('渲染出与稿子一致的 SVG 规格：24 视窗、currentColor、1.6 描边、默认 18px', () => {
    const html = renderToStaticMarkup(<Icon name="pencil" />);

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.6"');
    expect(html).toContain('width="18"');
    expect(html).toContain('height="18"');
    expect(html).toContain(iconPath('pencil'));
  });

  it('size 与 className 可覆盖，且默认对读屏隐藏', () => {
    const html = renderToStaticMarkup(<Icon name="trash" size={14} className="spin" />);

    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
    expect(html).toContain('class="spin"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('分页四枚齐全（五批列表页都要用）', () => {
    for (const name of ['pg-first', 'pg-prev', 'pg-next', 'pg-last'] as const) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});
