/**
 * 浏览器基线（单一真源）
 *
 * 依据：docs/decisions.md D56「Windows 10 兼容基线」
 *   ① Web 端最低基线 = Windows 10 22H2 + Microsoft Edge，Chromium/Edge 111 级别；
 *   ② 前端构建锁 `browserslist` + Vite `build.target`，CI 加 target 校验；
 *   ③ **不支持 IE11 与浏览器「兼容模式」**（360 / QQ 浏览器须切极速模式）。
 *
 * 这里的常量同时被 `vite.config.ts`（构建目标）和 `src/browser-baseline.test.ts`
 * （基线回归测试）引用，改动只改这一处。
 */

/** Vite `build.target`：ESBuild 目标写法，锁 Chromium/Edge 111 级别。 */
export const BUILD_TARGETS = ['chrome111', 'edge111'] as const;

/** 供 `package.json` 的 browserslist 对照断言用（生产环境）。 */
export const BROWSERSLIST_BASELINE = ['Edge >= 111', 'Chrome >= 111'] as const;

/** 明确不支持的浏览器/模式（D56 ③），写进入驻说明与 README。 */
export const UNSUPPORTED_BROWSERS = ['IE11', 'Edge 兼容模式', '360/QQ 浏览器兼容模式'] as const;

/** 人脸可读的基线描述，用于顶栏/关于页与文档。 */
export const BROWSER_BASELINE_LABEL = 'Windows 10 22H2 + Edge（Chromium 111+）；不支持 IE11';
