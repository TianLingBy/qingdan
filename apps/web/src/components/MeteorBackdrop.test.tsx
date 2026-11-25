import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MeteorBackdrop } from './MeteorBackdrop';

const CSS = fs.readFileSync(path.resolve(__dirname, '../styles/app-v30.css'), 'utf8');

describe('流星雨背景（纯装饰）', () => {
  it('渲染成不进无障碍树、不吃鼠标事件的背景层', () => {
    const html = renderToStaticMarkup(<MeteorBackdrop />);

    expect(html).toContain('class="meteor-bg"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<canvas');
  });

  it('不是卡片：没有 card / panel 这类容器类', () => {
    const html = renderToStaticMarkup(<MeteorBackdrop />);

    expect(html).not.toContain('card');
    expect(html).not.toContain('panel');
  });

  it('active=false 时整层不渲染（亮色 / 非暗色页面根本不挂）', () => {
    expect(renderToStaticMarkup(<MeteorBackdrop active={false} />)).toBe('');
  });

  it('SSR 不抛错（画布逻辑只在 useEffect 里跑）', () => {
    expect(() => renderToStaticMarkup(<MeteorBackdrop />)).not.toThrow();
  });

  it('样式是「铺在背景」而不是「一块卡片」：fixed + 不吃事件 + 无底色无边框', () => {
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*position:\s*fixed/s);
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*inset:\s*0/s);
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*pointer-events:\s*none/s);
    expect(CSS).not.toMatch(/\.meteor-bg\s*\{[^}]*background:/s);
    expect(CSS).not.toMatch(/\.meteor-bg\s*\{[^}]*border:/s);
  });

  it('右上角棱形星星按钮与「只看星空」样式都在', () => {
    expect(CSS).toMatch(/\.sky-btn\s*\{[^}]*position:\s*fixed/s);
    expect(CSS).toMatch(/\.sky-btn::before\s*\{[^}]*transform:\s*rotate\(45deg\)/s);
    expect(CSS).toMatch(/\.sky-btn:hover svg\s*\{[^}]*rotate\(90deg\)/s);
    expect(CSS).toMatch(/body\.is-sky \.wrap\s*\{[^}]*opacity:\s*0/s);
  });
});
