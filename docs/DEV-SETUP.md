# 轻单 · 开发环境与仓库骨架（人类开发者版）

> **面向**：4 位人类协作开发者。**先读** `docs/ONBOARDING.md`（接入流程）→ 本文件（环境与目录）→ `docs/TEAM-PLAN.md`（分工与排期）→ 你的 `docs/module-<模块>.md`。
> **前置口径**：技术栈按 `docs/adr-0001-tech-stack.md` 的方案 A（TypeScript 全栈），**D53 已拍板（2026-11-04）**；若将来换栈，只需改本文件 §2 与 §3，业务契约不受影响。
> **当前状态（2026-11-04）**：M0 骨架**已建立**——`packages/contracts|cli|mcp` 与 `apps/api|web` 五个包、根 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / ESLint 基座已进仓，`pnpm -r build`、`pnpm -r test` 与 `tests\run.ps1` 可跑；业务模块仍在各 `feat/<模块>` 分支施工。

---

## 1. 前置条件：软件清单（6 项必装 + 1 项可选；先装齐必装项，再 clone）

> **这一节是「开工第 0 步」。** 表里的 6 项必装装不齐，后面会出现三类假故障：`git clone` 报 404（其实是登录的账号不对）、`pnpm` 版本冲突（大版本不对）、`.ps1` 中文报错（用的是 5.1）。GitHub CLI（`gh`）是可选工具。
> **版本基准**：下表「实测版本」是 2026-11-04 在负责人 Windows 机器上 `--version` 的真实输出。成员机器可以更新，但 **Node 必须 24.x、pnpm 必须 11.x**——`package.json` 的 `engines` 会硬校验，不符合直接报错。

| # | 软件 | 版本要求 | 实测版本 | 下载地址 | 为什么必须有 | 验证命令 |
|---|---|---|---|---|---|---|
| 1 | **Git**（Windows 用 Git for Windows） | ≥ 2.40 | 2.53.0.windows.2 | <https://git-scm.com/download/win> ／ `winget install --id Git.Git -e` | 拉代码、建分支、提交。**安装时务必勾选 Git Credential Manager**，否则私有仓每次操作都要重输密码 | `git --version` |
| 2 | **Node.js** | **24 LTS（24.x）** | 24.22.0 | <https://nodejs.org/en/download> ／ `winget install --id OpenJS.NodeJS.24 -e`（`package.json` 的 `engines.node` 是 `">=24 <25"`；LTS 别名会随时间漂移到 26，装错版本会被 `engines` 拒绝） | 全部代码的构建与运行环境；`engines.node = ">=24 <25"` | `node -v` |
| 3 | **pnpm** | **11.x** | 11.28.10 | `corepack enable`（Node 自带）或 `npm i -g pnpm@11.28.10` | 仓库用 `packageManager: pnpm@11.28.10` 锁版本；**大版本不对会 store 冲突** | `pnpm -v` |
| 4 | **PowerShell 7**（命令名 `pwsh`） | ≥ 7.0 | 7.6.9 | <https://aka.ms/powershell-release?tag=stable> ／ `winget install --id Microsoft.PowerShell -e` | 所有 `.ps1`（测试、hook、bootstrap）的运行时。**不要用系统自带 5.1**，它按 GBK 解码中文脚本会报 `The string is missing the terminator` | `pwsh -v` |
| 5 | **PostgreSQL** | **18** | 18.x | <https://www.postgresql.org/download/windows/> ／ `winget install --id PostgreSQL.PostgreSQL.18 -e` | 本地开发库；CI integration job 用 `postgres:18`。D57 实测 PGlite 0.5.15 = PG 18.6，主版本必须一致 | `psql --version` |
| 6 | **编辑器** | 任意 | VS Code | <https://code.visualstudio.com/> | 建议装 ESLint / Prettier / EditorConfig 插件（配置随骨架提交） | — |
| 可选 | **GitHub CLI（命令名 `gh`）** | ≥ 2.60 | 2.97.0 | <https://cli.github.com/> ／ `winget install --id GitHub.cli -e` | 装了更省事：可用 `gh auth login` 配身份、`gh api` 自查权限、`gh` 建 PR；不装用网页一样能完成（见 [`docs/ONBOARDING.md`](ONBOARDING.md) §11） | `gh --version`（有 gh 才做） |

**不需要装**：Docker（只有 L3 并发测试可选使用）、Redis、消息队列、Java / Python 运行时。

macOS / Linux 必装项对应命令：`brew install git node pnpm postgresql@18`、`brew install --cask powershell`；Ubuntu 用微软官方 apt 源装 `powershell`，PostgreSQL 用 `postgresql-18`。GitHub CLI（`gh`）是可选项，想装再走官方安装源。

### 1.1 装完先跑这段自检（逐行复制执行）

```powershell
node -v                 # 期望 v24.x
pnpm -v                 # 期望 11.x
git --version           # 期望 2.4x 或更新
pwsh -v                 # 期望 7.x（在 5.1 里跑这行会报错，正说明你没装 PS7）
psql --version          # 期望 18.x（只影响 L3 真库测试，不阻塞前三个门禁）

# 以下只为可选工具 gh，有 gh 才做
gh --version            # 期望 2.6x 或更新
gh auth status                    # 期望：Logged in to github.com account <你的账号>
gh api user --jq '.login'         # 确认当前 git/gh 用的是哪个 GitHub 账号
gh api repos/TianLingBy/qingdan --jq '.permissions' # 有 gh 才做
# 期望输出：{"admin":false,"maintain":false,"pull":true,"push":true,"triage":true}
# 若这里报 404 → 见 §7 FAQ 第一行：登录的账号不是被邀请进仓库的那个
```

没有 gh 也能检查仓库权限：用浏览器打开 <https://github.com/TianLingBy/qingdan>，能打开就说明有权限；打不开＝账号不对或没被邀请。

**四条（不含 gh 那条）都要对上才算环境就绪**：Node 24.x、pnpm 11.x、pwsh 7.x、能访问本仓库（有 gh 时以 `gh api` 结果为准，没有 gh 时以浏览器能打开为准）。

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

> 下述示例中的 `postgres` 是本地开发默认口令，不是生产凭证。

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
| **`git clone` 报 404 / `Repository not found`** | 本机 git/gh 登录的 GitHub 账号**不是**被邀请进仓库的那个。私有仓对无权限账号一律返回 404（不是 403），所以看起来像「权限没开」 | ① `gh api user --jq '.login'` 看当前身份；② 换账号：`gh auth login` 用被邀请的账号登录；③ 清旧凭据：`cmdkey /delete:git:https://github.com`；④ 仍 404 就让负责人用正确账号重发邀请。**别只看浏览器能打开就以为命令行也对**——两者凭据可以不同 |
| `pre-commit: 找不到 pwsh` | PATH 无 PS7 | 装 PowerShell 7（§1 第 5 项） |
| `gh: 不是内部或外部命令` | 没装 GitHub CLI，或装完没重开终端 | 装 gh（§1 第 2 项）后**重开终端**再验证 |
| `git clone` 卡住几十分钟 | 网络到 github.com 不通 | 先 `gh api repos/TianLingBy/qingdan` 判断是网络还是身份；不通就换网络/代理，别反复重试 |
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
