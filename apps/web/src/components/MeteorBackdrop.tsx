import { useEffect, useRef } from 'react';

/**
 * 背景装饰：流星雨（#435 追加）。
 *
 * 定位：**不是卡片**，是铺在整页背后的装饰层（`.meteor-bg` 固定定位、`pointer-events: none`），
 * 只用来看，不承载任何信息；内容块（`.meteor-fg`）压在它上面。
 *
 * 三条底线：
 *   1. **纯装饰**：`aria-hidden`，不进无障碍树，不接收鼠标事件，不影响任何交互与布局；
 *   2. **尊重减少动效**：`prefers-reduced-motion: reduce` 时只画静态星点，不落流星；
 *   3. **不烧电**：只看得到时画 —— canvas 被隐藏（`offsetParent` 为空）或标签页在后台时跳过绘制；
 *      DPR 最多 2×，星点密度按面积算，卸载即取消 rAF 与监听。
 *
 * 颜色不写死：运行时从设计令牌读 `--accent-light`（流星头）与 `--text-3`（星点/拖尾），
 * 亮暗模式切换（`html[data-mode]` 变化）时重新取色，所以不需要额外改令牌。
 */

interface Star {
  x: number;
  y: number;
  r: number;
  alpha: number;
  speed: number;
  phase: number;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  life: number;
  max: number;
  width: number;
  accent: boolean;
}

const FALLBACK_ACCENT = '#3C5A4E';
const FALLBACK_STAR = '#9AA39C';

function readPalette(): { accent: string; star: string } {
  if (typeof window === 'undefined') return { accent: FALLBACK_ACCENT, star: FALLBACK_STAR };
  const style = window.getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    // color-mix() 这类计算结果 canvas 不一定认，退回兜底色，避免整层不画。
    return value && !value.includes('color-mix') ? value : fallback;
  };
  return { accent: pick('--accent-light', FALLBACK_ACCENT), star: pick('--text-3', FALLBACK_STAR) };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function MeteorBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let lastFrame = 0;
    let nextMeteorAt = 0;
    let palette = readPalette();
    let stars: Star[] = [];
    let meteors: Meteor[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(40, Math.min(150, Math.round((width * height) / 4600)));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.4 + Math.random() * 1.15,
        alpha: 0.2 + Math.random() * 0.6,
        speed: 0.3 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const spawnMeteor = () => {
      const fromLeft = Math.random() > 0.42;
      const speed = 330 + Math.random() * 520;
      const angle = ((fromLeft ? 28 : 152) * Math.PI) / 180;
      meteors.push({
        x: fromLeft ? -30 - Math.random() * 120 : width + 30 + Math.random() * 120,
        y: -20 - Math.random() * 140,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.62,
        length: 120 + Math.random() * 200,
        life: 0,
        max: 1.4 + Math.random() * 1.2,
        width: Math.random() < 0.26 ? 2.2 : 1.4,
        accent: Math.random() < 0.36,
      });
      if (meteors.length > 12) meteors.shift();
    };

    const frame = (timestamp: number) => {
      raf = window.requestAnimationFrame(frame);
      // 装饰层被隐藏或标签页在后台：不画（rAF 继续挂着，回来即恢复）。
      if (!canvas.isConnected || canvas.offsetParent === null || document.hidden) return;

      const delta = Math.min(0.05, (timestamp - (lastFrame || timestamp)) / 1000);
      lastFrame = timestamp;
      context.clearRect(0, 0, width, height);

      for (const star of stars) {
        const twinkle = 0.55 + 0.45 * Math.sin((timestamp / 1000) * star.speed + star.phase);
        context.globalAlpha = star.alpha * twinkle;
        context.fillStyle = palette.star;
        context.beginPath();
        context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        context.fill();
      }

      if (!prefersReducedMotion()) {
        if (timestamp > nextMeteorAt) {
          spawnMeteor();
          nextMeteorAt = timestamp + 300 + Math.random() * 850;
        }
        for (const meteor of meteors) {
          meteor.life += delta;
          meteor.x += meteor.vx * delta;
          meteor.y += meteor.vy * delta;
          const fade = Math.max(0, 1 - meteor.life / meteor.max);
          const norm = Math.hypot(meteor.vx, meteor.vy) || 1;
          const dx = meteor.vx / norm;
          const dy = meteor.vy / norm;
          const tail = meteor.length * (0.55 + 0.45 * fade);
          const segments = 9;
          for (let index = 0; index < segments; index += 1) {
            const from = index / segments;
            const to = (index + 1) / segments;
            const taper = (1 - from) * (1 - from);
            context.globalAlpha = (meteor.accent ? 0.85 : 0.6) * fade * taper;
            context.strokeStyle = meteor.accent ? palette.accent : palette.star;
            context.lineWidth = meteor.width * (0.45 + (1 - from) * 0.7);
            context.lineCap = 'round';
            context.beginPath();
            context.moveTo(meteor.x - dx * tail * from, meteor.y - dy * tail * from);
            context.lineTo(meteor.x - dx * tail * to, meteor.y - dy * tail * to);
            context.stroke();
          }
          context.globalAlpha = 0.95 * fade;
          context.fillStyle = meteor.accent ? palette.accent : palette.star;
          context.beginPath();
          context.arc(meteor.x, meteor.y, meteor.width * 1.05, 0, Math.PI * 2);
          context.fill();
        }
        meteors = meteors.filter(
          (meteor) =>
            meteor.life < meteor.max && meteor.x > -420 && meteor.x < width + 420 && meteor.y < height + 420,
        );
      }

      context.globalAlpha = 1;
    };

    resize();
    raf = window.requestAnimationFrame(frame);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    // 亮暗模式切换（html[data-mode]）后重新取色，避免一直用旧颜色。
    const observer = new MutationObserver(() => {
      palette = readPalette();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="meteor-bg" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
