import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkyBackground } from './SkyBackground';

describe('星空层（布局层挂载）', () => {
  it('非目标页面：active=false 时不渲染任何东西', () => {
    expect(renderToStaticMarkup(<SkyBackground active={false} isDark />)).toBe('');
  });

  it('亮色模式：即使 active 也不渲染（不出现流星雨与按钮）', () => {
    expect(renderToStaticMarkup(<SkyBackground active isDark={false} />)).toBe('');
  });

  it('暗色 + active：渲染背景层、棱形星星按钮与提示', () => {
    const html = renderToStaticMarkup(<SkyBackground active isDark />);

    expect(html).toContain('meteor-bg');
    expect(html).toContain('<canvas');
    expect(html).toContain('sky-btn');
    expect(html).toContain('aria-label="只看星空"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('sky-hint');
    // 白色描边五角星（不是填充图标）
    expect(html).toContain('<path d="M12 3.4l2.5 5.2');
  });

  it('挂载点在布局层：组件本身不依赖路由，只认 active 与主题', () => {
    // 组件没有 useRouterState / useLocation 依赖 —— 传入 active 就能在任何布局里复用
    const html = renderToStaticMarkup(<SkyBackground active isDark />);
    expect(html.length).toBeGreaterThan(0);
  });
});
