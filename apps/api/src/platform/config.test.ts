import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

/**
 * `PUBLIC_BASE_URL` 启动校验（2026-11-10 负责人拍板）。
 *
 * 背景：Cookie 写操作的同源校验只认这个基址（D59⑧），本地 dev:web 必须填
 * `http://localhost:5173`，生产必须填真实域名/IP。写错的两种后果——
 * 填成本机地址上线 → 所有写操作 403；填成非法 URL → 同源判断不可靠。
 * 所以这里把它做成启动即失败，而不是等运维在浏览器里排查。
 */
describe('PUBLIC_BASE_URL 校验', () => {
  it('未配置 → 空串（按请求 Host 推断同源）', () => {
    const config = loadConfig({});
    expect(config.publicBaseUrl).toBe('');
  });

  it('开发环境允许 localhost:5173（Vite 代理端口）', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:5173',
    });
    expect(config.publicBaseUrl).toBe('http://localhost:5173');
  });

  it('去掉结尾斜杠，避免与浏览器 Origin 拼出双斜杠', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      PUBLIC_BASE_URL: 'http://localhost:5173/',
    });
    expect(config.publicBaseUrl).toBe('http://localhost:5173');
  });

  it('生产环境填真实域名 → 通过', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://qingdan.example.com',
    });
    expect(config.publicBaseUrl).toBe('https://qingdan.example.com');
  });

  it('生产环境填 IP + 端口 → 通过（备案未下来时先走 IP）', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://203.0.113.10',
    });
    expect(config.publicBaseUrl).toBe('http://203.0.113.10');
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://0.0.0.0:3000'])(
    '生产环境填本机地址 %s → 拒绝启动',
    (value) => {
      expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: value })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: value })).toThrow(
        /不能指向本机地址/,
      );
    },
  );

  it('非法 URL → 拒绝', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'not-a-url' }),
    ).toThrow(ConfigError);
  });

  it('非 http(s) 协议 → 拒绝', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'ftp://qingdan.example.com' }),
    ).toThrow(/只支持 http \/ https/);
  });
});
