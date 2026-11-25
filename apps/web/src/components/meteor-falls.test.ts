import { describe, expect, it } from 'vitest';
import { planShower, planSmallShower } from './meteor-falls';

/** 固定种子的伪随机，保证用例可复现。 */
function seeded(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

describe('大流星雨的落法编排', () => {
  it('总颗数 12–20、两种落法各占一半（30%–70%）', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const plan = planShower({ width: 1440, height: 900, rand: seeded(seed) });
      const groups = plan.filter((entry) => entry.kind === 'group');
      const radiant = plan.filter((entry) => entry.kind === 'radiant');
      expect(plan.length).toBeGreaterThanOrEqual(12);
      expect(plan.length).toBeLessThanOrEqual(20);
      expect(groups.length).toBeGreaterThan(0);
      expect(radiant.length).toBeGreaterThan(0);
      const ratio = groups.length / plan.length;
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(0.7);
    }
  });

  it('小分队每组 3–5 颗、同一斜角（26°–58°）', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const plan = planShower({ width: 1440, height: 900, rand: seeded(seed) });
      const groups = new Map<number, number[]>();
      for (const entry of plan) {
        if (entry.kind !== 'group') continue;
        expect(entry.tilt ?? 0).toBeGreaterThanOrEqual(26);
        expect(entry.tilt ?? 0).toBeLessThanOrEqual(58);
        groups.set(entry.groupId ?? -1, [...(groups.get(entry.groupId ?? -1) ?? []), entry.tilt ?? 0]);
      }
      for (const tilts of groups.values()) {
        // 同一组斜角完全一致
        expect(new Set(tilts).size).toBe(1);
        expect(tilts.length).toBeGreaterThanOrEqual(3);
        expect(tilts.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('小分队不在同一起跑线：起点横向与纵深都错开', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const plan = planShower({ width: 1440, height: 900, rand: seeded(seed) });
      const groups = plan.filter((entry) => entry.kind === 'group');
      const xs = groups.map((entry) => entry.x ?? 0);
      const ys = groups.map((entry) => entry.y ?? 0);
      // 同一组内（同斜角）也要错开，不只是组与组之间
      const byGroup = new Map<number, number[]>();
      for (const entry of groups) {
        const key = entry.groupId ?? -1;
        byGroup.set(key, [...(byGroup.get(key) ?? []), entry.x ?? 0]);
      }
      for (const startXs of byGroup.values()) {
        if (startXs.length < 2) continue;
        expect(Math.max(...startXs) - Math.min(...startXs)).toBeGreaterThan(100);
      }
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
    }
  });

  it('小分队有前有后：组内到达时间错开 ≥ 70ms', () => {
    const plan = planShower({ width: 1440, height: 900, rand: seeded(7) });
    const byGroup = new Map<number, number[]>();
    for (const entry of plan) {
      if (entry.kind !== 'group') continue;
      const key = entry.groupId ?? -1;
      byGroup.set(key, [...(byGroup.get(key) ?? []), entry.at]);
    }
    for (const times of byGroup.values()) {
      const sorted = [...times].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(70);
      }
    }
  });

  it('辐射点个体按泊松（指数）间隔铺在约 7 秒内，不是固定节拍', () => {
    const plan = planShower({ width: 1440, height: 900, rand: seeded(11), total: 12 });
    const radiant = plan.filter((entry) => entry.kind === 'radiant').map((entry) => entry.at);
    expect(radiant.length).toBeGreaterThan(3);
    const sorted = [...radiant].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((value, index) => value - sorted[index]!);
    // 间隔不应全部相同（固定节拍会全是同一个数）
    expect(new Set(gaps.map((gap) => Math.round(gap / 50))).size).toBeGreaterThan(1);
    expect(sorted[sorted.length - 1]!).toBeGreaterThan(2000);
    expect(sorted[sorted.length - 1]!).toBeLessThan(20000);
  });
});

describe('小流星雨', () => {
  it('6–10 颗，全部是辐射点个体', () => {
    const plan = planSmallShower(8);
    expect(plan.length).toBe(8);
    expect(plan.every((entry) => entry.kind === 'radiant')).toBe(true);
  });
});
