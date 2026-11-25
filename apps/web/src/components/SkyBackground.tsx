import { useEffect, useState } from 'react';
import { MeteorBackdrop } from './MeteorBackdrop';

/**
 * 星空层：流星雨背景 + 右上角棱形星星按钮 + 「只看星空」。
 *
 * 为什么单独抽出来、挂在 `AppLayout`（#435 收尾，负责人 2026-11-26 拍板）：
 * 设置中心那一页属 #434（温汇敏）的改动范围，把挂载点写进 `SettingsPage.tsx`
 * 会和他的改动纠缠。这里做成**布局层挂一次**的装饰组件，谁想用由布局决定传 `active`。
 *
 * 三条底线：
 * 1. **纯装饰**：背景不进无障碍树、不吃鼠标事件；按钮有 aria-label / aria-pressed；
 * 2. **只在暗色 + 指定页出现**：`active` 由调用方按路由给，亮色下直接不渲染；
 * 3. **可退出**：切到亮色、离开该页、卸载组件都会清掉 `body.is-sky`，页面不会一直隐身。
 */

/** 当前是否暗色（`html[data-mode]`）。主题换了要跟着变，所以监听属性变化。 */
export function useIsDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.mode === 'dark',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.mode === 'dark');
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => sync();
    media?.addEventListener?.('change', onChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', onChange);
    };
  }, []);
  return dark;
}

export interface SkyBackgroundProps {
  /** 当前页面是否要星空层（由布局按路由判断） */
  readonly active: boolean;
  /** 覆盖暗色判断（测试 / SSR 注入用；不传则读 `html[data-mode]`） */
  readonly isDark?: boolean;
}

export function SkyBackground({ active, isDark: darkOverride }: SkyBackgroundProps) {
  const detectedDark = useIsDarkMode();
  const isDark = darkOverride ?? detectedDark;
  const [skyOnly, setSkyOnly] = useState(false);
  const [firing, setFiring] = useState(false);
  const [burst, setBurst] = useState(0);
  const on = active && isDark;

  // 离开该页 / 切亮色 / 卸载：退出「只看星空」，别让页面一直隐身
  useEffect(() => {
    if (!on) setSkyOnly(false);
  }, [on]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('is-sky', on && skyOnly);
    return () => document.body.classList.remove('is-sky');
  }, [on, skyOnly]);

  useEffect(() => () => {
    if (typeof document !== 'undefined') document.body.classList.remove('is-sky');
  }, []);

  if (!on) return null;

  const toggleSky = () => {
    setSkyOnly((current) => {
      if (current) return false;
      setBurst((count) => count + 1);
      setFiring(true);
      window.setTimeout(() => setFiring(false), 700);
      return true;
    });
  };

  return (
    <>
      <MeteorBackdrop burst={burst} />
      <button
        type="button"
        className={`sky-btn${skyOnly ? ' on' : ''}${firing ? ' is-firing' : ''}`}
        aria-pressed={skyOnly}
        aria-label="只看星空"
        title="只看星空"
        onClick={toggleSky}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.4l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" />
        </svg>
      </button>
      <div className="sky-hint" aria-hidden="true">
        只看星空 · 点击星星回到页面
      </div>
    </>
  );
}
