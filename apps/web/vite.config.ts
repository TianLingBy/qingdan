import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 轻单 Web（React SPA，后续 Electron / Capacitor 复用同一产物）
 *
 * 浏览器基线见 docs/decisions.md **D56**：
 *   - 最低基线 = Windows 10 22H2 + Microsoft Edge，Chromium/Edge **111** 级别；
 *   - `build.target` 在此显式锁死（不跟随 Vite 默认值漂移），与 `package.json` 的
 *     `browserslist`（`Edge >= 111` / `Chrome >= 111`）同源；
 *   - 常量在 `src/browser-baseline.ts` 导出，`src/browser-baseline.test.ts` 断言本文件
 *     的 `WEB_BUILD_TARGET` 与它一致（两边同时改才算数，防漂移）；
 *   - **不支持 IE11，也不支持任何浏览器的「兼容模式」**（360 / QQ 浏览器须切极速模式）。
 */

/** D56②：构建目标 = Chromium/Edge 111 级别。 */
export const WEB_BUILD_TARGET = ['chrome111', 'edge111'] as const;

/** docs/DEV-SETUP.md §4：dev 时 /api 代理到本地 api（3000）。 */
export const WEB_API_PROXY_TARGET = 'http://127.0.0.1:3000';

/**
 * 代理前缀必须带尾斜杠：写成 '/api' 会把页面路由 `/api-integration` 也代理走
 * （Vite 代理是前缀匹配），dev/preview 下该页会 502。routes.test.ts 有回归断言。
 */
export const WEB_API_PROXY_PREFIX = '/api/';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: [...WEB_BUILD_TARGET],
    sourcemap: false,
    // 老机器性能预算（D56⑤）：避免单 chunk 过大
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [WEB_API_PROXY_PREFIX]: {
        target: WEB_API_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
});
