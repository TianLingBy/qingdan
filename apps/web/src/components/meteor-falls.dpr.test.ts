import { describe, expect, it } from 'vitest';
import { pickCanvasDpr } from './meteor-falls';

/**
 * 画布 DPR 封顶：设置页流星雨在 4K / 2× 屏上原本每帧重绘上千万像素，
 * 操作明显发卡。规则是「面积越大，DPR 上限越低」，且永不超过设备 DPR。
 */
describe('pickCanvasDpr', () => {
  it('小画布用满设备 DPR，但不超过 2', () => {
    expect(pickCanvasDpr(800, 600, 3)).toBe(2);
    expect(pickCanvasDpr(800, 600, 1.5)).toBe(1.5);
  });

  it('中等面积封到 1.5', () => {
    expect(pickCanvasDpr(1600, 900, 2)).toBe(1.5);
  });

  it('大屏（>260 万 CSS 像素）封到 1.25', () => {
    expect(pickCanvasDpr(2560, 1440, 2)).toBe(1.25);
  });

  it('设备本身是 1× 时不升采样', () => {
    expect(pickCanvasDpr(2560, 1440, 1)).toBe(1);
  });
});
