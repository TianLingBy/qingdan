import { useEffect, useRef } from 'react';
import { planShower, planSmallShower, type FallPlanEntry } from './meteor-falls';

/**
 * 背景装饰：流星雨（#435；落法见 `meteor-falls.ts`）。
 *
 * 定位：**不是卡片**，是铺在整页背后的装饰层（`.meteor-bg` 固定定位、`pointer-events: none`），
 * 只用来看，不承载任何信息。页面内容正常叠在它上面（卡片自带底色，流星只在空隙里出现）。
 *
 * 四条底线：
 *   1. **纯装饰**：`aria-hidden`，不进无障碍树、不接鼠标事件、不影响布局；
 *   2. **只在暗色 + 挂载页出现**：`active` 由上层决定（亮色下根本不渲染）；
 *   3. **尊重减少动效**：`prefers-reduced-motion: reduce` 时只画静态星点，不落流星；
 *   4. **不烧电**：标签页在后台不绘制；DPR 最多 2×；卸载即取消 rAF 与监听。
 *
 * 颜色不写死：运行时从设计令牌读 `--accent-light`（流星头）与 `--text-3`（星点/拖尾）。
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
  kind: 'sporadic' | 'group' | 'radiant';
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 拖尾基准长度；radiant 成员绘制时按离辐射点距离重算（透视） */
  len: number;
  life: number;
  max: number;
  width: number;
  accent: boolean;
  glow: boolean;
  /** 辐射点坐标（只有 radiant 成员有） */
  rx?: number;
  ry?: number;
}

interface Pending {
  at: number;
  entry: FallPlanEntry | null;
}

const FALLBACK_ACCENT = '#3C5A4E';
const FALLBACK_STAR = '#9AA39C';
const MAX_METEORS = 90;

function readPalette(): { accent: string; star: string } {
  if (typeof window === 'undefined') return { accent: FALLBACK_ACCENT, star: FALLBACK_STAR };
  const style = window.getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value && !value.includes('color-mix') ? value : fallback;
  };
  return { accent: pick('--accent-light', FALLBACK_ACCENT), star: pick('--text-3', FALLBACK_STAR) };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface MeteorBackdropProps {
  /** 是否运行；false 时不渲染（亮色 / 非暗色页面由上层控制） */
  readonly active?: boolean;
  /** 每次递增会立刻撒一拨流星（进「只看星空」时用） */
  readonly burst?: number;
}

export function MeteorBackdrop({ active = true, burst = 0 }: MeteorBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const burstRef = useRef(burst);

  useEffect(() => {
    burstRef.current = burst;
  }, [burst]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let lastFrame = 0;
    let nextSporadicAt = 0;
    let nextSmallAt = 0;
    let nextBigAt = 0;
    let lastBurst = burstRef.current;
    let palette = readPalette();
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let pending: Pending[] = [];
    const radiant = { x: 0, y: 0 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 辐射点压在顶部一带：流星从那里向下散开，近处短、远处长
      radiant.x = width * (0.26 + Math.random() * 0.48);
      radiant.y = height * (-0.06 + Math.random() * 0.1);
      const count = Math.max(60, Math.min(220, Math.round((width * height) / 7000)));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.4 + Math.random() * 1.2,
        alpha: 0.2 + Math.random() * 0.62,
        speed: 0.3 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
      }));
    };

    const enqueue = (entries: readonly FallPlanEntry[]) => {
      const t0 = lastFrame || 0;
      for (const entry of entries) pending.push({ at: t0 + entry.at, entry });
    };

    /** 零星/辐射点个体（随机方向，或者从辐射点飞出） */
    const spawnRadiant = () => {
      const angle = Math.PI * (0.1 + Math.random() * 0.8);
      const distance = 30 + Math.random() * 170;
      const speed = 240 + Math.random() * 260;
      meteors.push({
        kind: 'radiant',
        rx: radiant.x,
        ry: radiant.y,
        x: radiant.x + Math.cos(angle) * distance,
        y: radiant.y + Math.sin(angle) * distance,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        len: 20,
        life: 0,
        max: 2.8 + Math.random() * 1.4,
        width: Math.random() < 0.18 ? 2.1 : 1.05 + Math.random() * 0.6,
        accent: Math.random() < 0.32,
        glow: Math.random() < 0.14,
      });
    };

    const spawnSporadic = () => {
      const fromLeft = Math.random() < 0.48;
      const tilt = (12 + Math.random() * 66) * (Math.PI / 180);
      const angle = fromLeft ? tilt : Math.PI - tilt;
      const speed = 300 + Math.random() * 640;
      meteors.push({
        kind: 'sporadic',
        x: fromLeft ? -(60 + Math.random() * 220) : width + 60 + Math.random() * 220,
        y: Math.random() < 0.8 ? -40 - Math.random() * 160 : Math.random() * height * 0.42,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * (0.55 + Math.random() * 0.5),
        len: 80 + Math.random() * 260,
        life: 0,
        max: 1.1 + Math.random() * 1.6,
        width: 1 + Math.random() * 1.7,
        accent: Math.random() < 0.4,
        glow: Math.random() < 0.3,
      });
    };

    const spawnGroup = (entry: FallPlanEntry) => {
      const tilt = ((entry.tilt ?? 40) * Math.PI) / 180;
      const angle = entry.fromLeft ? tilt : Math.PI - tilt;
      const speed = entry.speed ?? 420;
      meteors.push({
        kind: 'group',
        x: entry.x ?? -200,
        y: entry.y ?? -120,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        len: entry.len ?? 180,
        life: 0,
        max: 2.2 + Math.random() * 1.1,
        width: Math.random() < 0.2 ? 2 : 1.05 + Math.random() * 0.5,
        accent: Math.random() < 0.32,
        glow: Math.random() < 0.16,
      });
    };

    const drain = (ts: number) => {
      if (!pending.length) return;
      const due = pending.filter((item) => item.at <= ts);
      if (!due.length) return;
      pending = pending.filter((item) => item.at > ts);
      for (const item of due) {
        if (!item.entry) spawnSporadic();
        else if (item.entry.kind === 'radiant') spawnRadiant();
        else spawnGroup(item.entry);
      }
      if (meteors.length > MAX_METEORS) meteors = meteors.slice(meteors.length - MAX_METEORS);
    };

    const frame = (ts: number) => {
      raf = window.requestAnimationFrame(frame);
      if (document.hidden) return;
      const delta = Math.min(0.05, (ts - (lastFrame || ts)) / 1000);
      lastFrame = ts;
      context.clearRect(0, 0, width, height);

      for (const star of stars) {
        const twinkle = 0.55 + 0.45 * Math.sin((ts / 1000) * star.speed + star.phase);
        context.globalAlpha = star.alpha * twinkle;
        context.fillStyle = palette.star;
        context.beginPath();
        context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        context.fill();
      }

      if (!prefersReducedMotion()) {
        if (nextSporadicAt === 0) nextSporadicAt = ts + 400;
        if (nextSmallAt === 0) nextSmallAt = ts + 6000 + Math.random() * 8000;
        if (nextBigAt === 0) nextBigAt = ts + 24000 + Math.random() * 20000;
        if (ts > nextSporadicAt) {
          pending.push({ at: ts, entry: null });
          nextSporadicAt = ts + 150 + Math.random() * 520;
        }
        if (ts > nextSmallAt) {
          enqueue(planSmallShower());
          nextSmallAt = ts + 18000 + Math.random() * 22000;
        }
        if (ts > nextBigAt) {
          enqueue(planShower({ width, height }));
          nextBigAt = ts + 75000 + Math.random() * 60000;
        }
        if (burstRef.current !== lastBurst) {
          lastBurst = burstRef.current;
          const n = 10 + Math.round(Math.random() * 6);
          for (let k = 0; k < n; k += 1) pending.push({ at: ts + Math.random() * 1400, entry: { kind: 'radiant', at: 0 } });
        }
        drain(ts);

        for (const meteor of meteors) {
          meteor.life += delta;
          meteor.x += meteor.vx * delta;
          meteor.y += meteor.vy * delta;
          // 辐射点成员的拖尾按「离辐射点的距离」算：近处短一截，远处拉长（透视）
          let length = meteor.len;
          if (meteor.kind === 'radiant' && meteor.rx !== undefined && meteor.ry !== undefined) {
            const distance = Math.hypot(meteor.x - meteor.rx, meteor.y - meteor.ry);
            length = Math.min(280, Math.max(12, distance * 0.17));
          }
          const fade = meteor.kind === 'radiant'
            ? Math.min(1, (meteor.max - meteor.life) / 0.35)
            : Math.max(0, 1 - meteor.life / meteor.max);
          const norm = Math.hypot(meteor.vx, meteor.vy) || 1;
          const dx = meteor.vx / norm;
          const dy = meteor.vy / norm;
          const tail = length * (0.55 + 0.45 * fade);
          const segments = meteor.kind === 'sporadic' ? 9 : 10;
          const base = meteor.accent ? 0.88 : 0.62;
          for (let index = 0; index < segments; index += 1) {
            const from = index / segments;
            const to = (index + 1) / segments;
            const taper = (1 - from) * (1 - from);
            context.globalAlpha = base * fade * taper;
            context.strokeStyle = meteor.accent ? palette.accent : palette.star;
            context.lineWidth = meteor.width * (0.4 + (1 - from) * 0.75);
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
          if (meteor.glow) {
            context.globalAlpha = 0.22 * fade;
            context.beginPath();
            context.arc(meteor.x, meteor.y, meteor.width * 3.8, 0, Math.PI * 2);
            context.fill();
          }
        }
        meteors = meteors.filter(
          (meteor) => meteor.life < meteor.max && meteor.x > -620 && meteor.x < width + 620 && meteor.y < height + 620,
        );
      } else {
        meteors = [];
        pending = [];
      }
      context.globalAlpha = 1;
    };

    resize();
    raf = window.requestAnimationFrame(frame);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    const observer = new MutationObserver(() => {
      palette = readPalette();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [active]);

  if (!active) return null;
  return (
    <div className="meteor-bg" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
