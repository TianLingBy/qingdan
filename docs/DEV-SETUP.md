# 轻单 · 开发环境与仓库骨架（人类开发者版）

> **面向**：4 位人类协作开发者。**先读** `docs/ONBOARDING.md`（接入流程）→ 本文件（环境与目录）→ `docs/TEAM-PLAN.md`（分工与排期）→ 你的 `docs/module-<模块>.md`。
> **前置口径**：技术栈按 `docs/adr-0001-tech-stack.md` 的方案 A（TypeScript 全栈），**D53 已拍板（2026-11-04）**；若将来换栈，只需改本文件 §2 与 §3，业务契约不受影响。
> **当前状态（2026-11-04）**：M0 骨架**已建立**——`packages/contracts|cli|mcp` 与 `apps/api|web` 五个包、根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / ESLint 基座已进仓，`pnpm -r build`、`pnpm -r test` 与 `tests\run.ps1` 可跑；业务模块仍在各 `feat/<模块>` 分支施工。

---

## 1. 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| git | 任意较新 | 私有仓，需先被邀请（write 权限） |
| PowerShell 7+ | `pwsh` ≥ 7 | 测试与 hook 依赖；**不要用 5.1** |
| Node.js | **24 LTS** | 本机已有 `%LOCALAPPDATA%\nvm\v24.22.0`；PATH 默认可能是 18，注意切换 |
| pnpm | **11.x** | 本机副本 `D:\tools\pnpm11`；仓库里用 `packageManager` 字段锁版本 |
| PostgreSQL | **18** | 本地开发库；CI 的 integration job 用 `postgres:18` 容器。D57 实测 PGlite 0.5.15 = PG **18.6**，测试与生产主版本必须一致 |
| 编辑器 | 任意 | 建议 VS Code + ESLint/Prettier 插件（配置随骨架一起提交） |

不需要：Docker（除 L3 并发测试可选）、Redis、消息队列。

## 2. 第一次安装（clone 之后）

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
pwsh -NoProfile -File bootstrap.ps1          # 装 hook + 跑全量测试（含 testbase / workspace / platform-spec 底座测试）
```

M0 骨架已建立（2026-11-04），clone 后按顺序执行：

```powershell
corepack enable            # 或直接用 D:\tools\pnpm11
pnpm install               # 依赖已锁进 pnpm-lock.yaml；禁止 pnpm add / pnpm add -D
pnpm -r build              # 首次编译 contracts / cli / mcp / api / web
pnpm -r test               # 各包 vitest
pwsh -NoProfile -File tests\run.ps1   # 全量门禁，退出码 0 才算过
```

数据库（二选一）：

```powershell
# 本地服务（推荐开发时用）
# 装 PostgreSQL 18 后建库：createdb qingdan_dev
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/qingdan_dev'

# 或 Docker
docker run -d --name qingdan-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
```

迁移：

```powershell
pnpm -C apps/api migrate         # 纯 SQL 迁移，前向 only
pnpm -C apps/api seed            # 演示数据（可选）
```

## 3. 仓库结构（2026-11-04 已建立）

```
qingdan/
  apps/
    api/                        ← 后端，唯一部署物
      src/platform/             ← 共享底座：权限引擎、审计、取号、审批、单据框架、待办、Token
      src/modules/<模块>/       ← 8 个业务模块，结构固定
        routes.ts               ← 只做挂载与鉴权包装
        usecases/               ← 服务层用例（业务规则唯一落地处）
        repo.ts                 ← 只操作本模块的表
        schema.ts               ← 引用 packages/contracts 的 schema
      src/main.ts
    web/                        ← React SPA（后续 Electron/Capacitor 复用同一产物）
  packages/
    contracts/                  ← ★ 唯一契约包：动作枚举、错误码、金额类型、路由注册表、Zod schema
    cli/                        ← qingdan CLI（从注册表生成命令树）
    mcp/                        ← MCP Server（从注册表生成工具表）
  tests/                        ← *.test.ps1（包装 pnpm test），run.ps1 不改
  docs/
```

**当前已落地内容**：`packages/contracts` 已有注册表与发射器（`src/domains.ts` 功能域词表、`src/routes.ts`
端点注册表、`src/errors.ts` 错误码封闭枚举、`src/entities.ts` 实体、`src/openapi.ts` OpenAPI 3.1 发射）
与 `src/*.test.ts` 用例；`apps/api`、`apps/web`、`packages/cli`、`packages/mcp` 目前是带
`package.json` / `tsconfig.json` 的空壳，业务代码由各 `feat/<模块>` 分支填充。

**边界规则（会在 ESLint / CI 里机械检查）**：

1. 业务模块只能从 `packages/contracts` 与 `apps/api/src/platform` 的公开入口 import；**禁止** `modules/a` → `modules/b` 直接 import。
2. 业务模块只能操作自己的表；要别人的数据，调对方服务层函数或走只读视图。
3. 每个业务动作必须先有 `contracts` 里的注册项（route + scope + 审计标记），否则不许写 handler。
4. 所有写操作必须调用平台审计写入（D51）；所有接口必须出现在 `GET /api/v1/openapi.json`。

## 4. 本地运行

```powershell
pnpm -C apps/api dev        # 后端 http://127.0.0.1:3000（/api/v1）
pnpm -C apps/web dev        # 前端 http://127.0.0.1:5173（代理到 api）
pnpm -C packages/cli dev -- --help
pnpm -C packages/mcp dev    # MCP Server（stdio 或 streamable http）
```

演示账号：seed 后打印到控制台（老板 / 经理 / 销售 / 仓管各一个），**不要**把真实手机号写进仓库。

## 5. 测试（唯一入口不变）

```powershell
pwsh -NoProfile -File tests\run.ps1        # 全量，退出码 0 才算过
pwsh -NoProfile -File tests\run.ps1 -Filter '*api*'   # 只跑某类
```

新增测试 = 新增 `tests\<模块>.test.ps1`，内部用 `pnpm test` 跑真实用例并把退出码映射出来；**不要改 `tests/run.ps1`**。

分层（与 ADR 一致）：

| 层 | 内容 | 依赖 | CI |
|---|---|---|---|
| L1 | 纯逻辑 / 契约 / OpenAPI 合法性 / CLI 退出码 / MCP 工具表 | 无 | windows + ubuntu |
| L2 | 用例 + 数据访问（PGlite 内存库） | PGlite | windows + ubuntu |
| L3 | 并发、锁、取号、真 PG 语义 | 真 PostgreSQL | 仅 ubuntu（integration job） |

## 6. 分支与提交

- 分支：`feat/<模块名>`（平台 = `feat/platform`），每日从 `main` rebase；长期分支不超过 1 周。
- 提交：一句话说清「模块 + 做了什么」，一次提交只做一件事。
- PR：按 `.github/pull_request_template.md` 填；一个 PR 只动本模块写范围；CI 绿 + 1 人评审才合并。
- 绝不 `git commit --no-verify` 绕过测试；hook 红就先修。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `pre-commit: 找不到 pwsh` | PATH 无 PS7 | 装 PowerShell 7 |
| `The string is missing the terminator` | 用 5.1 跑 `.ps1` | 一律 `pwsh`；新 `.ps1` 带 BOM |
| `pnpm` 版本冲突 | 系统 pnpm 与 `packageManager` 不一致 | 用 `D:\tools\pnpm11` 或 `corepack enable` |
| 数据库连不上 | 未设 `DATABASE_URL` 或服务未起 | 按 §2 设置；`psql -c 'select 1'` 验证 |
| L3 测试被跳过 | 未设 `QINGDAN_TEST_DB` | 本地跑需要真 PG；CI integration job 必设 |
| 跨模块 import 报错 | 违反 §3 边界规则 | 改走服务层函数或只读视图 |

## 8. 当前缺口（2026-11-04 进展）

1. `apps/api`、`apps/web`、`packages/contracts`、`packages/cli`、`packages/mcp` 五个骨架包 —— **已建立**，其中 `contracts` 已有注册表与用例，其余四包待各分支填充业务代码。
2. `package.json` + `pnpm-workspace.yaml` + `tsconfig` 基座 + ESLint（含跨模块 import 拦截）—— **已建立**，跨模块 import 拦截规则随业务模块落地补齐。
3. 迁移 runner 与第一版表结构（平台：tenant/company/employee/role/permission/audit/token）—— 待 `apps/api` 平台底座落地。
4. CI 增加 `setup-node` + `pnpm install` 与 integration job —— **已建立**（`.github/workflows/test.yml`：windows+ubuntu 矩阵 + 仅 ubuntu 的 PostgreSQL 18 integration job）。
5. seed 脚本与演示数据 —— 待 `apps/api` 迁移落地后补。
