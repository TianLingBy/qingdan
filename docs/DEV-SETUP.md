# 本地开发环境（DEV-SETUP）

> 面向新加入的成员：从零把 `apps/api` + `apps/web` 跑起来，并避开已知的坑。
> 部署到服务器的步骤见 `docs/deploy.md`，不要混用。

## 一、前置条件

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | `>=24 <25` | 根 `package.json` 的 `engines` 写死；Node 22/20 会在 `pnpm -r build` 阶段报语法错 |
| pnpm | 11 | `packageManager` 固定 `pnpm@11.28.10`，用 `corepack enable` 让 pnpm 跟着仓库走 |
| PostgreSQL | 18（可选） | 只跑单元测试不需要——`apps/api` 的测试用内存库 pglite；跑 `migrate` / `seed` / 真实联调才需要 |

## 二、首次安装

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
pwsh -NoProfile -File install-hooks.ps1   # 装受控 pre-commit（会当场跑一遍全量测试）
corepack enable
pnpm install
```

`install-hooks.ps1` 会把 `tools/pre-commit` 装进 `.git/hooks`。不想装也能开发，但提交前请自己跑一次
`pwsh -NoProfile -File tests\run.ps1`，CI 跑的是同一个入口。

## 三、数据库与种子数据

```powershell
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/qingdan_dev'
pnpm -C apps/api migrate   # 按 apps/api/migrations 文件名升序执行，已跑过的记在 schema_migrations
pnpm -C apps/api seed      # 写入演示租户/公司/员工/商品（账号与密码见 seed.ts 顶部注释）
```

- 迁移是**前向 only**（没有 down）：改错了就新增一条迁移去修，不要改历史文件——
  `schema_migrations` 存了 checksum，改历史文件会让所有环境启动即失败。
- 想看某条迁移是否跑过：`SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id;`

## 四、启动前后端（含 `PUBLIC_BASE_URL` 这个必设项）

```powershell
# 终端 1：API（http://127.0.0.1:3000/api/v1）
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/qingdan_dev'
$env:PUBLIC_BASE_URL = 'http://localhost:5173'      # ← dev 下可选，见下
pnpm -C apps/api dev

# 终端 2：Web（http://localhost:5173，/api/ 前缀代理到 3000）
pnpm -C apps/web dev
```

### dev 下的 `PUBLIC_BASE_URL`：设与不设分别会怎样

Cookie 认证的写操作要求「同源」（D59⑧）：只有「会话 Cookie 认证 + 非安全方法（POST / PUT / PATCH / DELETE）」
才执行同源校验，Bearer 请求不受约束（`apps/api/src/platform/auth/plugin.ts:18`、`:45`、`:153-160`）。
校验候选 = 浏览器 `Origin`（没有时退回 `Referer`）的 origin（`plugin.ts:94`）；候选缺失或与期望 origin
不一致 → `403 FORBIDDEN`（`plugin.ts:95-99`、`:111-113`）。

期望 origin 只有两个来源（`plugin.ts:104-109`）：

- 配了 `PUBLIC_BASE_URL` → **只认它的 origin**，请求 `Host` 完全不参与（`plugin.ts:104-106`）；
- 没配 → 用 `request.protocol` + 请求 `Host` 拼出来（`plugin.ts:107-109`）。

dev 的 Vite 代理是 `changeOrigin: false`（`apps/web/vite.config.ts:49`），即**保留浏览器发来的 `Host`**
（同文件 `:47-48` 的注释写明这一点：改成 `true` 会转发成目标地址的 `Host`）。代理目标默认
`http://127.0.0.1:3000`（`apps/web/vite.config.ts:24-25`），前缀 `/api/`（同文件 `:31`），
dev server 端口 5173（同文件 `:42`）。因此浏览器开 `http://localhost:5173` 时，API 收到的 `Host`
仍是 `localhost:5173`，按 Host 推断的期望 origin 就是 `http://localhost:5173`，与浏览器 `Origin` 相同
（Host 推断分支的用例：`apps/api/src/platform/auth/plugin.test.ts:167-187`）。所以：

- 不设 `PUBLIC_BASE_URL` → 期望 origin = `http://localhost:5173` → 写操作**正常**；
- 设成 `http://localhost:5173` → 期望 origin 仍是 `http://localhost:5173` → 写操作**正常**（与不设等价）；
- 设成 `http://127.0.0.1:3000` → 期望 origin 变成 `http://127.0.0.1:3000` ≠ 浏览器 `Origin` → **所有写操作 403**（`plugin.ts:104-112`）。

换成 `http://127.0.0.1:5173` 打开页面则相反：`Host` / `Origin` 都是 `127.0.0.1:5173`，不设正常，
设成 `http://localhost:5173` 反而 403（同样是 `plugin.ts:104-112` 的两个分支）。设它的价值是把期望 origin
钉死、不再信任请求 `Host`（`plugin.ts:102-103` 的注释）。

`Origin` 是否实际由浏览器发送、代理是否原样透传，属仓库代码之外的行为（`apps/web/vite.config.ts:44-49`
只有 `target` 与 `changeOrigin`，没有 Origin / Host 改写项）：待主线确认（需人工核实）。

两个补充事实：

1. **API 不读 `.env` 文件**（没有 dotenv 依赖），`process.env` 只来自当前 shell 或容器的 `env_file`；
   所以上面用 `$env:` 设置，别指望根目录 `.env` 在本地生效。
2. 生产环境（`NODE_ENV=production`）如果 `PUBLIC_BASE_URL` 仍然是 `localhost` / `127.0.0.1` / `0.0.0.0` / `::1`，
   API **直接拒绝启动**（`apps/api/src/platform/config.ts` 的 `assertPublicBaseUrl`）。
   这是刻意做的 fail-fast：上线漏配的真实表现就是「页面能开、一保存就 403」，与其让人在浏览器里猜，不如启动就报。

### 联调时的地址

| 用途 | 地址 |
| --- | --- |
| Web 页面 | http://localhost:5173 |
| API 直连 | http://127.0.0.1:3000/api/v1 |
| 健康检查 | http://127.0.0.1:3000/api/v1/health |
| OpenAPI 说明书 | http://127.0.0.1:3000/api/v1/openapi.json（静态件在 `docs/api/openapi.yaml`） |

## 五、常用命令

```powershell
pnpm -r typecheck          # 全部包类型检查
pnpm -r test               # 全部包单测（apps/api 用 pglite，不需要真库）
pnpm -r build              # 全部包构建
pnpm lint                  # ESLint
pnpm openapi               # 由 packages/contracts 的 Zod 注册表重生成 docs/api/openapi.yaml
pwsh -NoProfile -File tests\run.ps1   # 本地全量门禁（CI 同款，退出码 0 才算过）
```

改了 `packages/contracts` 的注册表（端点、入参、错误码）**必须**跑一次 `pnpm openapi` 并一起提交，
否则 CI 的 `spec-drift` 会红。

### 真 PostgreSQL 集成检查（L3）

本地单测全部跑在 pglite（进程内内存库），**并发 / 行锁 / RLS / 生成列**这类语义只有真 PG 才验证得了。
两条脚本在没有数据库时会打印 `SKIP` 并算作通过；CI 的 `integration (ubuntu-latest, PostgreSQL 18)`
带着 `QINGDAN_TEST_DB` 真跑，所以「本地 SKIP」不等于没验：

```powershell
# 任选其一：本机真 PG，或 docker 起一个
$env:QINGDAN_TEST_DB = 'postgres://postgres:postgres@127.0.0.1:5432/qingdan_test'
pwsh -NoProfile -File tests\db-concurrency.test.ps1   # 并发取号不重号 / 批次行锁 / RLS / available_qty 非负
pwsh -NoProfile -File tests\e2e-business-flow.test.ps1 # 登录 → E 单 → 扣库存 → C 草案 → 确认结算
```

注意脚本会先 `pnpm -C packages/contracts build`：干净 clone 里契约包只有 `src/`，不构建会报 `MODULE_NOT_FOUND`。

## 六、常见故障

| 现象 | 原因与处理 |
| --- | --- |
| 页面能打开，但保存/新增/删除全部 403 | `PUBLIC_BASE_URL` 与浏览器地址不同源，见 §4 |
| 启动报 `PUBLIC_BASE_URL 在生产环境不能指向本机地址` | `NODE_ENV=production` 却填了 localhost，改填真实域名/IP |
| 启动报 `迁移 checksum 不一致` | 有人改了历史迁移文件；不要改历史 SQL，新增一条迁移去修 |
| `dev:web` 起不来、报端口占用 | 5173 是 `strictPort`，先关掉占用进程（旧 dev 进程 / 另一个 Vite） |
| `pnpm install` 报 store 冲突 | 系统里装了 pnpm 10 又装 11；统一用 `corepack enable` 后的 pnpm |
