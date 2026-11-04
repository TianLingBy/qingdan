import { describe, expect, it } from 'vitest';
import {
  BROWSERSLIST_BASELINE,
  BROWSER_BASELINE_LABEL,
  BUILD_TARGETS,
  UNSUPPORTED_BROWSERS,
} from './browser-baseline';
import { WEB_API_PROXY_TARGET, WEB_BUILD_TARGET } from '../vite.config';
import packageJson from '../package.json';

/**
 * D56 浏览器基线回归测试：build.target 与 browserslist 必须是
 * 「Chromium/Edge 111 级别」，且不得出现 IE11。
 * 这里同时校验 vite.config.ts 里的实际构建目标，防两处漂移。
 */
describe('浏览器基线（D56）', () => {
  it('build.target 锁 Chromium/Edge 111 级别', () => {
    expect(BUILD_TARGETS).toEqual(['chrome111', 'edge111']);
    for (const target of BUILD_TARGETS) {
      expect(target).toMatch(/^(chrome|edge)\d+$/);
      expect(Number.parseInt(target.replace(/^[a-z]+/, ''), 10)).toBeGreaterThanOrEqual(111);
    }
  });

  it('vite.config.ts 的 build.target 与基线常量一致', () => {
    expect([...WEB_BUILD_TARGET]).toEqual([...BUILD_TARGETS]);
  });

  it('dev proxy 指向本地 api（127.0.0.1:3000）', () => {
    expect(WEB_API_PROXY_TARGET).toBe('http://127.0.0.1:3000');
  });

  it('package.json 的 browserslist 与基线常量同源，且不包含 IE', () => {
    const browserslist = packageJson.browserslist as { production: string[] };
    expect(browserslist.production).toEqual([...BROWSERSLIST_BASELINE]);
    for (const entry of browserslist.production) {
      expect(entry.toLowerCase()).not.toBe('ie 11');
      expect(entry).toMatch(/^(Edge|Chrome) >= 111$/);
    }
  });

  it('明确声明不支持 IE11 与兼容模式', () => {
    expect(UNSUPPORTED_BROWSERS).toContain('IE11');
    expect(BROWSER_BASELINE_LABEL).toContain('IE11');
    expect(BROWSER_BASELINE_LABEL).toContain('Chromium 111');
  });
});
