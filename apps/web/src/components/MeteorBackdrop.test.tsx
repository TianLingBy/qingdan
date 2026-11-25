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

  it('SSR 不抛错（画布逻辑只在 useEffect 里跑）', () => {
    expect(() => renderToStaticMarkup(<MeteorBackdrop />)).not.toThrow();
  });

  it('样式是「铺在背景」而不是「一块卡片」：绝对定位 + 不吃事件 + 内容在上层', () => {
    // 装饰层：绝对铺满、z-index 0、不吃鼠标事件
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*position:\s*absolute/s);
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*inset:\s*0/s);
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*z-index:\s*0/s);
    expect(CSS).toMatch(/\.meteor-bg\s*\{[^}]*pointer-events:\s*none/s);
    // 内容块压在装饰层之上
    expect(CSS).toMatch(/\.meteor-fg\s*\{[^}]*z-index:\s*1/s);
    // 定位上下文由页面容器提供
    expect(CSS).toMatch(/\.meteor-stage\s*\{[^}]*position:\s*relative/s);
    expect(CSS).toMatch(/\.meteor-stage\s*\{[^}]*isolation:\s*isolate/s);
    // 没有底色/边框，才叫「融进背景」
    expect(CSS).not.toMatch(/\.meteor-bg\s*\{[^}]*background:/s);
    expect(CSS).not.toMatch(/\.meteor-bg\s*\{[^}]*border:/s);
  });
});
