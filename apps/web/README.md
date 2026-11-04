# @qingdan/web · 轻单 Web 端骨架

React 19 + Vite 8 + TanStack Router/Query + Tailwind 4 的单页应用骨架。后续 Electron / Capacitor 复用同一产物。

## 浏览器基线（docs/decisions.md **D56**）

- 最低基线：**Windows 10 22H2 + Microsoft Edge**，Chromium/Edge **111** 级别。
- 构建端双重锁定：`vite.config.ts` 的 `build.target = ['chrome111','edge111']`（常量在 `src/browser-baseline.ts`）+ `package.json` 的 `browserslist`（`Edge >= 111` / `Chrome >= 111`）。
- **不支持 IE11，也不支持任何浏览器的「兼容模式」**（360 / QQ 浏览器须切极速模式）。
- 桌面端（Electron）仅 Win10 1809+ / Win11；Win7/8 不做。

## 命令

```powershell
# 仓库根目录，Node 24 + pnpm 11
pnpm -C apps/web dev       # http://127.0.0.1:5173，/api 代理到 http://127.0.0.1:3000
pnpm -C apps/web build     # tsc --noEmit && vite build → dist/
pnpm -C apps/web test      # vitest（纯逻辑，无 jsdom）
pnpm -C apps/web typecheck
```

## 目录

```
src/
  main.tsx              入口（挂载 #root）
  App.tsx               QueryClientProvider + RouterProvider
  index.css             @import "tailwindcss" + 全局基础样式
  browser-baseline.ts   D56 基线常量（build.target / browserslist 同源）
  router/
    routes.ts           22 页 IA 路由表（纯数据，唯一真源）
    router.tsx          createRootRoute/createRoute/RouterProvider 所需 router 实例
    routes.test.ts      22 条齐全 + 无重复
  layouts/AppLayout.tsx 左侧导航（按功能域分组）+ 顶栏
  pages/PlaceholderPage.tsx  占位页（标题 + 待实现 + 功能域）
  api/
    client.ts           fetch 封装（/api/v1、统一错误体 ApiError、X-Request-Id、Authorization）
    query.ts            QueryClient 配置
    client.test.ts      URL 拼接 + 错误体解析
```

## 现状与未做

- 22 条路由（`docs/prototype-v0.md` §2 页 1–22）全部是占位页，**没有业务逻辑、没有视觉设计**。
- 登录态 / 权限过滤 / 数据请求均未接入；权限与公司数据隔离最终必须服务端判定（D15/D27），前端隐藏不算数。
- `/commissions`、`/customer-returns`、`/supplier-returns` 不是独立页：prototype-v0 把提成并入 C 单、把 R/S/I 合并为第 8 页「冲正单据」，因此它们是页内分栏。
