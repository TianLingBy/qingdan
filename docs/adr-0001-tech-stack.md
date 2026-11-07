# ADR-0001 技术栈选型

> 公开仓说明：文中出现的 `Dxx` 编号与 `docs/decisions.md`、`docs/project-context.md` 等文件属于**内部决策资料**，不在公开仓内维护；此处保留历史引用是为了让决策链可追溯，不影响本文结论。

| 项 | 内容 |
|---|---|
| 状态 | ✅ **已接受（2026-11-04 负责人拍板）**——结论已落 `docs/decisions.md` **D53**；U1-U5 已落 D55；U12 spike 已完成（`docs/spike-0001-tech-pipeline.md`，9/9 通过），据此 **PostgreSQL 主版本改为 18**、契约注册表须注册 id、应用账号须非 superuser，见 D57 |
| 日期 | 2026-11-04 |
| 提出 | 架构协作者（adr-architect） |
| 决策者 | 项目负责人（拍板人），Lead 汇总 |
| 影响范围 | 全部 8 个开发模块 + P0 `platform` 开工前置 + CI + 部署 |
| 关联口径 | D1 / D11 / D15 / D22 / D31 / D44 / D51 / D52 / D52.1 |
| 解决哪条未知 | `docs/project-context.md` §8-3「技术栈与多端收敛方式」（唯一仍空着的未知项） |

> 本 ADR 只回答「用什么技术、为什么、选错怎么退」。**不定义业务口径**——权限、审计、金额、单据状态一律以 `docs/decisions.md` 为准；也不改任何现有契约。

---

## 背景与约束

### 产品与规模（决定「不需要什么」）

- **对外 SaaS，云端单一形态**（D1）：云端是唯一记账真相，客户本地只有**只读备份副本**，断网只可看不可改。一期内不做买断版、不做在线订阅计费、不做记账/凭证/开票。
- **规模很小且可预测**：小团队经营的中小贸易/加工企业，**月单量 < 50 单/租户**，租户数量一期是个位数到几十。这意味着：**吞吐、分库分表、消息中间件、微服务、缓存层全部不需要**；任何把「性能」当主要理由的方案都应被否定。
- **团队极小**：实际上由「负责人 + 若干 AI 协作者」构成，8 个模块**并行**开发（`docs/ONBOARDING.md` §4），每人一个 `feat/<模块>` 分支、一个 PR 只碰本模块写范围。
- **四端顺序固定**（`docs/project-context.md` §6）：Web → Windows → macOS → Android，鸿蒙不做。明确「**不该写四遍**」，权限与业务逻辑只在后端一处生效。
- **AI 是头等公民**（D52/D52.1）：`qingdan` CLI 与 MCP Server 是与 Web **平级**的客户端，不是附属脚本；AI 生效权限每请求现算、不可放大、审批只能人类。

### 硬约束（每条都直接落到技术选型上）

| # | 约束 | 来源 | 对技术栈的硬要求 |
|---|---|---|---|
| C1 | 多租户 + 租户内多公司 + 「公司×岗位」权限，数据可见范围 = 绑定公司集合 | D1、D15 | 单一关系库 + `tenant_id`/`company_id` 贯穿；权限判定集中在一个进程内可复用的引擎里，**不能靠前端/Framework 的装饰器隐式魔法**，否则 8 个模块各写一套 |
| C2 | 权限**每请求重算**：`生效权限 = 绑定员工当前权限 ∩ token scope`，员工停用/改岗立即生效，不得缓存授权 | D52.1 ② | 判定必须便宜：**每请求 1~2 条 SQL**，不引入外部缓存；引擎必须能接收「人 / 机器」两种主体并走同一套逻辑 |
| C3 | **审计全量、只追加、不可改删、业务失败也记**，独立于业务事务追加 | D51、契约第三批 §1 | 审计表在**数据库层**禁止 UPDATE/DELETE（权限收回或触发器）；审计写入不能与业务事务同生共死 → 需要 outbox 或独立连接 |
| C4 | **API-first**：先服务层用例，再 `/api/v1` REST；**OpenAPI 3.1 是唯一接口真源**；CLI/MCP 与 REST 一对一、不得绕过权限与审计 | D52、契约第三批 §3/§4 | 必须有**单一的路由/契约注册表**同时驱动：路由、OpenAPI 文档、CLI 命令树、MCP 工具表、鉴权与审计中间件。这是本 ADR 的核心架构决定 |
| C5 | 通用 API 约定：游标分页、`Idempotency-Key` 24h、`If-Match` 乐观锁 409、`dryRun`、`X-Request-Id` 透传、ISO 8601 带时区、**金额 decimal 字符串** | 契约第三批 §3 | 语言要能表达精确十进制（或强制用库 + lint 禁裸 `number`）；需要有 request-scope 上下文（AsyncLocalStorage 一类）承载 requestId |
| C6 | 在途批次锁定：N 单在途期间批次可用量锁定、不得再被引用，到货后转司解锁 | D22、D31 | 必须能用 `SELECT … FOR UPDATE` / 唯一约束 / 行版本在同一事务内做**库存互斥**；`dryRun` 下不落库但结果一致 |
| C7 | 客户在线支付走**模式 A**：各企业自配商户号与密钥，平台只传指令、收回调，不碰钱 | D11 | 需要可靠的 HTTPS 出站、签名校验、**回调幂等**、**商户密钥加密落库**（不能明文、不能进日志） |
| C8 | 8 模块并行、跨模块只走接口、不直读对方表；一个 PR 一个写范围 | AGENTS.md、ONBOARDING §4 | 语言/工程结构要能**机械地**强制模块边界（lint 级 import 规则），且合并冲突面要小；不要有「一个中央文件所有人都在改」的结构 |
| C9 | 测试入口唯一：`tests/run.ps1` 逐个跑 `tests/*.test.ps1`，CI 在 **windows-latest 与 ubuntu-latest** 双平台跑 | `tests/run.ps1`、`.github/workflows/test.yml` | 新栈的测试必须能被 `.test.ps1` **包装**并以退出码 0/1 表达；数据库相关测试必须解决「Windows runner 没有 Docker」这一现实 |
| C10 | 桌面端/安卓端后续要做，且弱网/离线行为要有定义（一期只读） | `docs/project-context.md` §6 | 前端必须是一套 Web 代码 + 各端外壳，而不是四份实现 |

### 一句话结论的由来

上面 10 条里，**C4 是决定性的一条**：既然「同一个动作」要在 Web / CLI / MCP / REST 四个入口行为一致、错误码一致、日志字段一致，那么**四个入口共享一套类型与一套注册表**的收益，远大于任何单点技术优势。这直接指向「**单一语言 + 单一契约包**」的方案。

---

## 候选方案

三套候选。每套都是「能交付」的完整组合，不是拼凑。评估只看上面 C1–C10，**不看性能**（规模不需要）。

### 方案 A：TypeScript 全栈（Node.js + React）

| 维度 | 选择 |
|---|---|
| 后端语言/框架 | TypeScript 5.x（strict）+ **Node.js 24 LTS** + **Fastify 5** |
| 数据访问 | **Drizzle ORM** + `pg`（SQL-first，显式事务） |
| 数据库 | **PostgreSQL 17** |
| 前端 | **React 19 + Vite** + TanStack Query + Tailwind + Radix/shadcn |
| API 描述 | 单一 schema 注册表（**Zod 4**）→ JSON Schema 2020-12 → **发射 OpenAPI 3.1** |
| CLI | TS 独立包 `@qingdan/cli`，命令树由注册表生成（`commander`） |
| MCP | 官方 **`@modelcontextprotocol/sdk`**（TS），Streamable HTTP，工具由注册表生成 |
| 部署 | 单容器（Node 24 distroless）+ 托管 PostgreSQL |
| 测试 | Vitest + **PGlite**（WASM 版 PG）做逻辑/用例；真 PG 做并发；`tests/*.test.ps1` 包装 |

**优点**

- **一套语言覆盖后端、前端、CLI、MCP、契约包**：动作枚举、错误码、金额类型、权限 scope 只定义一次，四个入口不可能漂移（直接满足 C4）。
- **OpenAPI 3.1 是「构造出来的」，不是「维护出来的」**：Zod 4 能直接导 JSON Schema 2020-12，而 3.1 的 `components.schemas` 正是该方言。文档与实现同源，CI 里比对快照即可防漂移。
- **MCP 生态最成熟**：官方 TS SDK 是 MCP 的一等实现，Streamable HTTP、工具 schema、stdio 全有；AI 协作者写 TS 的收敛度也最高（8 个并行模块最怕「各人发明一套写法」）。
- **前端到四端最顺**：React 19 一套代码 → Web；Electron 外壳 → Windows/macOS；Capacitor 外壳 → Android。不需要第二语言。
- **本机可立即开工**：Node 已存在（本机 `C:\nvm4w\nodejs\node.exe` = v18.20.8，`%LOCALAPPDATA%\nvm\v24.22.0` 已有 Node 24，需切默认），`pwsh` 7.6.9 已有；**不需要装 SDK**。

**缺点（必须正视）**

- **没有原生 decimal**：金额必须用 `decimal.js` 一类库 + 自建 `Money` 值对象，靠 ESLint 禁裸 `number` 参与金额运算。这是纪律问题，不是能力问题，但**是真实的返工来源**（C5）。
- **金额从 DB 出来是字符串**：`node-postgres` 对 `numeric` 默认返回 string——这反而**正好符合契约「金额 decimal 字符串」**，但要求团队统一「金额在应用内是 `Money`，不是 `number`」。
- **运行时要 Node**：不像 .NET 能发单文件 exe；Windows 客户要 CLI 需额外打包（Node SEA 或 later）。一期 CLI 主要给 AI/内部用，可接受。
- **弱类型边界**：`any` 泄漏、运行时校验漏网的风险高于编译型语言 → 用 `strict` + `noUncheckedIndexedAccess` + Zod 边界校验兜住。

### 方案 B：.NET 全栈（C# + React）

| 维度 | 选择 |
|---|---|
| 后端语言/框架 | C# / **.NET 10** + ASP.NET Core Minimal API |
| 数据访问 | EF Core 10（或 Dapper） |
| 数据库 | PostgreSQL 17（或 SQL Server） |
| 前端 | React 19 + Vite（前端仍是 TS，两套语言） |
| API 描述 | `Microsoft.AspNetCore.OpenApi`（3.1 支持依赖 .NET 10，较早版本默认 3.0） |
| CLI | `System.CommandLine` 独立控制台项目 |
| MCP | 官方 C# MCP SDK（成熟度低于 TS） |
| 部署 | 自包含单文件可执行 或 容器 |
| 测试 | xUnit + Testcontainers / Respawn |

**优点**

- **原生 `decimal`**、强类型、编译期就能挡住一大类金额与状态机错误；EF Core 的 `[Timestamp]`/并发令牌对 C3/C5 的乐观锁最省事。
- **交付形态最干净**：`dotnet publish` 出单文件 exe，Windows 客户/内网部署体验最好（虽然一期是云端 SaaS，买断版二期会用到）。
- **强模块边界**：项目引用（`.csproj`）天然强制「不直读对方表」，比 lint 规则硬（C8）。
- **Windows 一等公民**：CI 的 `windows-latest` 与开发机都是原生环境。

**缺点**

- **两套语言**：后端 C# + 前端 TS，契约类型要跨语言同步（要么生成，要么手抄），这正是 C4 最怕的漂移源。
- **OpenAPI 3.1 是弱项**：早期 ASP.NET Core 只出 3.0，3.1 要 .NET 10 且生成器可定制性弱于「自己从 schema 发射」；要做到「工具与 REST 一对一」仍需自建注册表，等于白拿不到 C4 的红利。
- **8 个 AI 协作者并行写 C# 的收敛度低于 TS**：社区样例、模型熟悉度、生成代码风格一致性都更差；脚手架（DI 注册、中间件顺序）是共享热点，容易冲突。
- **本机没有 .NET SDK**（实测 `dotnet --info`：只有 runtime 8.0.21，`No SDKs were found`），开工前要多一步环境安装。

### 方案 C：Python 全栈（FastAPI + React）

| 维度 | 选择 |
|---|---|
| 后端语言/框架 | Python 3.13 + **FastAPI** + Pydantic v2 |
| 数据访问 | SQLAlchemy 2.x + Alembic |
| 数据库 | PostgreSQL 17 |
| 前端 | React 19 + Vite（两套语言） |
| API 描述 | FastAPI 原生产 **OpenAPI 3.1**（默认 3.1.0） |
| CLI | Typer（同样两套语言或需分发） |
| MCP | 官方 Python MCP SDK / FastMCP |
| 部署 | uvicorn/gunicorn 容器 |
| 测试 | pytest + testcontainers / pytest-postgresql |

**优点**

- **OpenAPI 3.1 原生**、Pydantic v2 的 schema 能力与 Zod 同级，**原生 `Decimal`**。
- 开发速度最快，写业务用例（服务层）心智负担最低；脚本化/数据处理顺手。
- 生态在 AI 侧最好（模型默认最熟），MCP Python SDK 也在第一梯队。

**缺点**

- **两套语言**（前端仍需 TS），C4 的单一契约包红利打对折。
- **部署与依赖管理更脆**：venv/锁文件/容器镜像体积、CI 上 Python 版本与 psycopg 编译，长期维护成本高于 Node；单文件分发困难（CLI 给客户）。
- **类型系统是「渐进」的**：大型权限/单据状态机在 Python 里靠 discipline 和 mypy，**编译期保障弱于 A/B**；8 个并行模块最容易在这里出现「字段名各写各的」。
- 本机 `python.exe` 指向 WindowsApps 占位（未验证可用版本），要多一步确认。

### 逐项对比总表

| 维度 | A：TS 全栈 | B：.NET 全栈 | C：Python 全栈 |
|---|---|---|---|
| 后端语言/框架 | TS / Fastify 5 | C# / ASP.NET Core | Python / FastAPI |
| 数据库 | PostgreSQL 17 | PostgreSQL 17 | PostgreSQL 17 |
| 前端 | React 19 + Vite | React 19 + Vite | React 19 + Vite |
| **语言数量（含前端/CLI/MCP）** | **1** | 2（C# + TS） | 2（Py + TS） |
| API 描述 / OpenAPI 3.1 | 自建注册表发射（可控、可校验） | 依赖 .NET 10 生成器，可控性弱 | 框架原生（最省事） |
| CLI | TS，可与服务共享类型 | C#，分发最干净 | Typer，分发较弱 |
| MCP | **官方 TS SDK（最成熟）** | C# SDK（较新） | Python SDK（成熟） |
| 金额精确性 | 需 `decimal.js` + lint 纪律 | **原生 decimal** | **原生 Decimal** |
| 金额传输 | `numeric`→string，天然合契约 | decimal→string 需显式转换 | Decimal→string 需显式转换 |
| 模块边界强制 | ESLint import 规则（软强制） | 项目引用（硬强制） | 约定 + mypy（最软） |
| 8 并发 AI 协作者收敛度 | **最高** | 中 | 中高 |
| 部署形态 | 单容器 | **单文件 exe / 容器** | 容器 |
| 四端外壳 | Electron / Capacitor（单语言） | Web 前端同左，但后端不参与 | 同左 |
| 双平台 CI 适配成本 | 低（Node 预装） | 低（.NET 预装） | 中（版本/psycopg） |
| 本机可开工成本 | **最低**（Node 24 已在） | 需装 SDK | 需确认 Python |
| 主要风险 | 金额纪律、运行时依赖 | 两套语言、3.1 生成器 | 类型弱、部署脆 |

> **考虑过但未入列**：**Go**（单二进制很香，但 OpenAPI 3.1 / MCP / 前端类型共享都要另起一套，且模型生成 Go 业务代码的收敛度一般）；**Rust**（引入第二语言，交付速度与 8 模块并行冲突）。这两者都属「为一个优点牺牲 C4」，本轮不推荐。

---

## 推荐方案

### 结论（一句话）

> **TypeScript 单语言全栈：Node.js 24 LTS + Fastify 5 + Drizzle + PostgreSQL 17，React 19 + Vite 做 Web，`packages/contracts` 里的 Zod 注册表同时发射 OpenAPI 3.1、CLI 命令树与 MCP 工具表，审计走「事务内 outbox + 独立追加器」，部署为单容器 + 托管 PG。**

即**方案 A**。

### 版本锁定清单

| 层 | 选型 | 版本基线 | 备注 |
|---|---|---|---|
| 运行时 | Node.js | **24 LTS** | 本机已有 `%LOCALAPPDATA%\nvm\v24.22.0`；PATH 默认仍是 18.20.8，需切换（见未决项 U4） |
| 包管理 | pnpm | **11.x** | 本机副本 `D:\tools\pnpm11`；`packageManager` 字段锁版本 |
| 语言 | TypeScript | 5.x，`strict` + `noUncheckedIndexedAccess` | ESM |
| HTTP 框架 | Fastify | 5.x | 不用 NestJS（见下方「为什么不」） |
| 校验/契约 | Zod | 4.x | `z.toJSONSchema()` 导 2020-12 |
| 数据访问 | Drizzle ORM + `pg` | 最新稳定 | SQL-first；不用 Prisma（引擎二进制 + 生成器不利于 CI/部署，且复杂 SQL 表达力弱） |
| 数据库 | PostgreSQL | 17 | `numeric` / `jsonb` / `timestamptz` / `ON CONFLICT` |
| 迁移 | 纯 SQL 迁移文件 + 迁移 runner | — | 前向only、可评审；不用 ORM 自动同步 |
| 前端 | React 19 + Vite + TanStack Query/Router + Tailwind + Radix | 最新稳定 | SPA，不做 SSR |
| CLI | `commander` + 注册表生成 | — | 包名 `@qingdan/cli`，bin `qingdan` |
| MCP | `@modelcontextprotocol/sdk` | 最新稳定 | Streamable HTTP |
| 测试 | Vitest + `@electric-sql/pglite`（逻辑/用例）+ 真 PG（并发） | — | 由 `tests/*.test.ps1` 包装 |
| 日志/观测 | `pino`（结构化 + requestId） | — | 一期不引入 OTel |
| 部署 | 单容器 + 托管 PG + 对象存储（备份/导出） | — | 无 k8s、无 Redis、无 MQ |

**为什么不选 NestJS**：装饰器 + 隐式 DI + 全局模块注册，会让 8 个并行模块在**共享的 DI 容器与 module 注册文件**上互相冲突，且它自带一套 OpenAPI 装饰器体系（会与 Zod 注册表形成两套真源）。Fastify 的插件/路由是显式注册，每个模块只在自己的 `routes.ts` 里挂载，冲突面最小。

**为什么不选 Prisma**：需要引擎二进制（CI/容器多一层）、迁移与复杂 SQL（`FOR UPDATE`、`ON CONFLICT DO UPDATE ... RETURNING`、部分索引）表达力弱，而这些恰好是 C5/C6 的刚需。Drizzle 直接写 SQL 片段，类型自动推导。

### 工程结构（写范围与模块边界）

```
qingdan/
  apps/
    api/                    ← 后端（唯一部署物）
      src/platform/         ← 权限引擎、审计、取号、审批、单据框架、待办、Token
      src/modules/<模块>/   ← 每模块固定结构，8 个模块互不越界
        routes.ts           ← 只做「注册表声明 + 挂 handler」
        usecases/           ← 服务层用例（业务规则唯一落地处）
        repo.ts             ← 只碰自己的表
        schema.ts           ← 引用 contracts 的 schema
      src/main.ts
    web/                    ← React SPA（后续 Electron/Capacitor 复用同一产物）
  packages/
    contracts/              ← ★ 唯一契约包：动作枚举/错误码/金额类型/路由注册表/Zod schema
    cli/                    ← qingdan CLI（从注册表生成命令树）
    mcp/                    ← MCP Server（从注册表生成工具表）
  tests/                    ← *.test.ps1（包装 pnpm test），run.ps1 不改
  docs/
```

**边界规则（可机械检查）**：

1. `packages/contracts` 与 `apps/api/src/platform` 是**共享写范围**，改动必须在 PR 描述里列受影响模块并 @ 负责人（对应 AGENTS.md「跨模块改动」条款）。
2. 业务模块**只能**从 `contracts` 与 `platform` 的公开入口 import；**禁止** `modules/a` → `modules/b` 直接 import（ESLint `no-restricted-imports` 按路径正则拦截）。
3. 业务模块**禁止**直连数据库里别人的表；需要对方数据只有两条路：调对方暴露的**服务层函数**，或走**只读视图 + 明确注释**。这条对应 AGENTS.md「跨模块只走接口，不直读对方数据表」。

### 七个支撑点：每一问逐一回答

| 要求 | 机制 | 落在哪 |
|---|---|---|
| **服务层用例** | 每个业务动作用例 = 纯函数式 `async execute(ctx, input): Promise<Result>`；`ctx` 含主体（人/AI）、权限快照、requestId、事务句柄。路由层只做「鉴权 → 调用例 → 序列化」，**没有第二处业务逻辑** | `apps/api/src/modules/*/usecases` |
| **`/api/v1` REST** | 路由前缀 `/api/v1` 由注册表统一加；handler 从注册表生成，杜绝「手写路由忘了鉴权」 | `contracts/registry.ts` + `api/routes` |
| **OpenAPI 3.1** | 注册表 → JSON Schema 2020-12 → 组装 `openapi: "3.1.0"` 文档，`GET /api/v1/openapi.json` 直接返回构建产物；CI 用 `swagger-parser`/`ajv`(2020-12) 校验文档合法，并用**响应快照测试**断言「文档里写的与实际返回一致」 | `contracts/openapi.ts` + `tests` |
| **CLI** | 同一注册表遍历生成命令树：`qingdan <功能域> <动作>`，自动带 `--json --dry-run --reason --if-match --idempotency-key`；退出码由错误码分类映射（0/2/3/4/5） | `packages/cli` |
| **MCP** | 同一注册表生成工具：一工具一路由，描述里自动写入「所需 scope / 是否需 reason / 是否危险动作需人类审批」；MCP 只调 HTTP，**不直连 DB**，因此不可能绕过权限与审计 | `packages/mcp` |
| **审计中间件** | ①**成功路径**：业务事务内写 `audit_outbox` 行（保证至少一次），提交后由追加器搬到只追加的 `audit_log`；②**失败路径**：无业务事务可依附，直接调追加器写 `result=fail`；③`audit_log` 表对应用角色**只给 INSERT**（`REVOKE UPDATE, DELETE`），物理上不可改删。写审计的任何异常都**不被吞**：返回 500 并告警（D51 要求全量，宁可失败不可漏记） | `api/src/platform/audit` |
| **乐观锁 / 幂等 / 游标分页** | 乐观锁：单据/批次带 `version`，`If-Match: "<version>"` → `UPDATE … WHERE id=$1 AND version=$2`，0 行 → 409 + 当前 version；幂等：`idempotency_key` 表（`unique(tenant_id,key)`，存 `request_hash` 与响应快照，24h 过期），**与业务写入同事务**，重复请求回放首次响应、hash 不一致 → 409（2026-11-04 由 D54 裁定，原写 422 已更正）；分页：不透明游标 `base64url({keys:[...],id})`，keyset 查询 `WHERE (created_at,id) < ($1,$2)`，`limit` 默认 50 / 上限 200 | `platform/http` + 各 repo |

### 契约第三批 §3 逐条落地（实现对照表）

| 契约条目 | 实现方式 |
|---|---|
| `/api/v1` 版本 | 注册表统一前缀；破坏性变更才起 `/api/v2`（v1 与 v2 并存期用同一用例层） |
| 人类 Cookie / 机器 Bearer | Cookie：`httpOnly`+`SameSite=Lax`+`Secure`，会话表存 PG（**不放内存**，为了多副本）；Bearer：32 字节随机不透明串，DB 只存 SHA-256 哈希，创建时明文仅返回一次 |
| 统一错误体 `{code,message,details,requestId}` | 一个 `AppError` 类型 + Fastify `setErrorHandler`；`code` 是**封闭枚举**（定义在 contracts，CLI 退出码与 MCP 错误映射都从这里取） |
| 游标分页 | 上面「游标分页」机制；`cursor` 不透明、服务端校验签名可防篡改排序注入 |
| `Idempotency-Key` 24h | 上面「幂等」机制；未带该头且是写接口 → 允许（不强制），带则严格 |
| `If-Match` → 409 | 上面「乐观锁」；GET 详情同时回 `ETag`，前端/AI 可直接回填 |
| `dryRun=true` | 用例层 `ctx.dryRun`：照常跑校验与计算，最后 `ROLLBACK`，返回「将要发生的变更」；**必须与真实执行走同一条代码路径**（否则预检无意义） |
| `X-Request-Id` | `AsyncLocalStorage` 存 requestId，全链路日志与审计透传；缺省生成 UUIDv7 |
| ISO 8601 带时区 | DB `timestamptz`，序列化统一 `toISOString()`；前端按租户时区展示 |
| 金额 decimal 字符串 | `Money` 值对象（`decimal.js`，内部 string 构造），DB `numeric`，进出接口一律 string；ESLint 禁裸 `number` 参与金额；**node-postgres 对 numeric 默认返回 string，正合契约** |
| `GET /api/v1/openapi.json` | 构建时从注册表发射为静态产物，运行时直接返回；CI 快照比对防漂移 |
| 审计 | 上面「审计中间件」 |
| CLI 退出码 0/2/3/4/5 | `usage`→2、`forbidden/unauthorized`→3、`validation`→4、`conflict`→5，其余→1；映射表放 contracts，CLI 与测试共用 |
| MCP 一工具一 REST | 注册表 1:1 生成；工具名 = `功能域_动作`，描述含 scope/审批要求；**危险动作**（删除/冲正/成本更正/结算确认/权限变更）在 MCP 层直接拒绝并回「需人类审批」+ 创建待办 |

### 权限引擎：如何做到「每请求重算」又不慢

D52.1 要求不得缓存授权。做法不是「每请求跑一堆查询」，而是**把重算压缩成固定 1~2 条 SQL**：

1. 请求进来 → 解析主体（session 或 token）→ 取 `employee` 状态（停用则立即 401/token 作废）。
2. 一条 SQL：`employee_company_role` ⋈ `role_permission` ⋈ `employee_permission_override`，`array_agg` 出「公司集合」与「功能域×动作」集合。
3. 若是 AI：再与 `api_token.scope` 取交集（纯内存集合运算），scope 里没有的动作直接 403。
4. 结果放进 `ctx.authz` 供本请求使用，**请求结束即丢**——没有跨请求缓存，满足「每请求重新判定、不缓存授权」。

8 动作 × 19 功能域规模下，这个集合运算成本可忽略；真正要防的是「某个模块自己写一套权限判断」——所以鉴权只发生在路由包装器一处，业务用例只读 `ctx.authz`。

### 测试策略：接住 `tests/run.ps1` 与双平台 CI

**硬原则：`tests/run.ps1` 一行不改**（它只是 `Get-ChildItem *.test.ps1` 逐个 spawn，用 `$LASTEXITCODE` 判失败）。新增测试**只新增 `.test.ps1` 文件**，内部 `pnpm` 调真实测试框架并映射退出码：

```powershell
# tests/api.test.ps1（示意）
. "$PSScriptRoot\assert.ps1"
& pnpm -C "$PSScriptRoot\.." test -- --run 2>&1 | Write-Host
Assert-True ($LASTEXITCODE -eq 0) "vitest 全绿"
Exit-Test
```

分三层，按「需不需要真数据库」拆开，正好化解「Windows runner 没有 Docker」：

| 层 | 内容 | 依赖 | 双平台 |
|---|---|---|---|
| L1 纯逻辑 / 契约 | 权限并集与覆盖、金额舍入、游标编解码、错误体、**OpenAPI 文档合法性与快照**、CLI 解析与退出码、MCP 工具表与路由 1:1 | 无 DB | ✅ Windows + Ubuntu 都跑 |
| L2 用例 + 数据访问 | 服务层用例（建单、取消级联、幂等回放、409 冲突、dryRun 不落库、审计 outbox） | **PGlite**（WASM 版 PG，进程内、无需服务） | ✅ 双平台都跑 |
| L3 并发与真实语义 | 跨月 0 点取号并发、`FOR UPDATE` 在途锁定（D22/D31）、唯一约束、迁移前向性 | **真 PostgreSQL** | Ubuntu（service container）必跑；Windows 本地用 Docker |

- L3 单独一个脚本 `tests/db-concurrency.test.ps1`，**环境不具备时不得静默通过**：检测 `QINGDAN_TEST_DB` 未设 → 打印 `SKIP（需真 PG）` 并以 **退出码 0** 通过（不算失败），但 CI 的 `integration` job 里该变量必设，**Skip 在那里=红**。
- 契约测试是「防漂移」的核心：每个路由至少一条用例，断言实际响应能被 OpenAPI 3.1 文档里对应 schema 校验通过；再加一条「文档里每个 path+method 都有 handler、每个 handler 都在文档里」的双向断言。
- CI 演进（**不在本 ADR 写范围内，需 Lead 排期**）：现有 `test.yml` 加 `actions/setup-node` + `pnpm install` 后跑 `tests/run.ps1` 即可覆盖 L1/L2；新增 `integration` job（仅 ubuntu + `postgres:17` service）跑 L3。**在 CI 改完之前，`tests/run.ps1` 仍全绿**，不阻塞并行开发。

### 安全与支付（C7）

- 配置：`zod` 校验的环境变量 schema，启动即 fail-fast；`.env` 不入库（`.gitignore` 已有）。
- 商户密钥：**AES-256-GCM 加密后落库**，KEK 只来自环境变量（一期）或云 KMS（二期）；密钥**永不进日志、永不进审计变更摘要**。
- 支付回调：独立路由，签名校验 → 幂等写（`unique(channel, outbound_no)`）→ 推进入账状态；回调失败可重放。
- 审计脱敏：`audit_log.变更摘要` 的金额字段按 D27「看价」权限脱敏**在写入前**完成（不是查询时再过滤，避免日志本身成为越权数据源）。

### 前端与四端收敛（C10）

- **一期**：React SPA，纯静态产物由同一容器托管；权限只做「隐藏/禁用」的 UX，服务端仍判定（D15/D27 不变）。
- **二期 Windows/macOS**：Electron 外壳加载同一 SPA 构建产物；主进程只做窗口、自动更新、**只读离线缓存（SQLite）**。
- **三期 Android**：Capacitor 包同一 SPA。
- **离线语义**（D1：只读）：本地库标记 `readonly=1`，所有写操作在离线时被 UI 与服务端双重拒绝，联网后只同步「读」。**具体同步协议目前无材料，属阶段 5 设计**——本 ADR 只保证「不选一个做不到离线的栈」。

---

## 风险与回退

### 决策可逆性分级（这是回退计划的前提）

| 级别 | 决策 | 说明 |
|---|---|---|
| 🟢 **易逆** | HTTP 框架、ORM、前端 UI 库、日志库、测试框架 | 都在模块内部，替换是局部改动 |
| 🟡 **半可逆** | 语言/运行时（TS↔C#/Python）、前端框架（React↔Vue） | 服务层用例与契约包可搬，但要重写胶水；成本随代码量线性增长 |
| 🔴 **基本不可逆** | **数据库引擎与 SQL 方言**、**多租户隔离模型**、**金额精度与舍入规则**、**审计只追加的实现承诺** | 一旦有真实租户数据，改动=数据迁移 + 正确性风险；必须在写第一行业务代码前定死 |

**换栈窗口**：`platform` 验收前（还没有真实租户数据）——这之前任何栈都能换；**第一个付费租户上线后，只允许增量演进**，不再整体换栈。所以本 ADR 要求在 platform 开工前拍板，晚了就退化成本不可逆。

### 风险清单

| # | 风险 | 概率/影响 | 缓解 | 回退动作 |
|---|---|---|---|---|
| R1 | **金额纪律失守**（某处用 `number` 算钱，浮点误差进毛利/提成） | 中 / **高**（D5 毛利、提成、结算全被污染） | `Money` 值对象是唯一入口；ESLint 禁 `number` 与金额字段运算；金额相关用例做**属性测试**（拆分/合并守恒、舍入幂等）；代码评审清单单列一条 | 发现即修；已入库数据用「重算脚本 + 差异报告」修正，不需换栈 |
| R2 | **审计漏记**（业务提交后进程崩溃，outbox 已写但未搬） | 中 / **高**（D51 违规） | outbox 与业务**同事务**保证至少一次；追加器幂等（`outbox_id` 唯一）；每日对账任务：业务写入数 vs 审计数，差异告警 | 修追加器 + 补录脚本（补录需 `system` 操作者类型，仍只追加）；不换栈 |
| R3 | **OpenAPI 与实现漂移**（有人手改文档或绕过注册表加路由） | 中 / 中 | 注册表是唯一入口；CI 双向断言 + 文档快照；路由层禁止直接 `fastify.get()`（lint 拦截） | CI 红即修；不换栈 |
| R4 | **PGlite 与真 PG 语义差异**（L2 绿但 L3 挂） | 中 / 中 | PGlite 只用于 L1/L2；所有并发/锁/约束相关必须 L3 真 PG；L3 在 CI 必跑 | 扩大 L3 覆盖面即可；不换栈 |
| R5 | **Node 生态与 CI/部署摩擦**（Node 18→24、pnpm store 冲突、容器体积） | 中 / 低 | `packageManager` + `engines` 锁版本；CI 固定 `setup-node@24`；镜像用 distroless/alpine + 多阶段构建 | 有 pnpm/store 问题用锁定版本容器构建；不换栈 |
| R6 | **多租户隔离被绕过**（某接口漏 `tenant_id` 条件 → 跨租户读数据） | 低 / **极高**（D14 红线） | 所有 repo 查询必须经 `withTenant()` 包装器（强制注入 `tenant_id`）；**数据库层再加一道**：`audit`/`doc` 等核心表启用 RLS，按 `current_setting('app.tenant_id')` 过滤；跨租户访问做专门测试 | 修 + 加测试；不换栈 |
| R7 | **数据库引擎被证明不合适**（如未来买断版要求 SQL Server） | 低 / 高 | 数据访问集中在 `repo.ts`，**限定只用** `numeric/jsonb/timestamptz/ON CONFLICT/FOR UPDATE` 这类 PG/标准交集特性，不碰 PG 独有扩展 | 换库 = 重写 repo 层 + 迁移脚本；**估计 2–4 人周**（一期规模）。这就是「半可逆」的真实成本，宁可现在把特性用窄 |
| R8 | **前端四端收敛失败**（Electron 太重、Capacitor 能力不足） | 中 / 中 | 一期只做 Web，先不背桌面端的复杂度；Electron 与 Capacitor 都是外壳，业务零改动 | 换 Tauri（引入 Rust）只影响外壳层；**不动后端** |
| R9 | **8 模块并行导致契约漂移**（各模块私改 contracts） | 中 / 高 | `contracts` 与 `platform` 列为共享写范围，改动必须 PR 描述列受影响模块；CI 跑契约测试 | 冲突在 PR 阶段暴露；不换栈 |
| R10 | **团队/负责人更熟 .NET 或 Python** | 未知 / 中 | 本 ADR 明确写出「什么条件会推翻推荐」（见下） | 若拍板改 B/C：**现在换成本最低**，改动集中在工程骨架，契约第三批的实现对照表大部分可复用 |
| R11 | **租户老电脑（Windows 10）+ 浏览器过旧，前端跑不起来**（负责人 2026-11-04 提出） | 中 / 高（客户当场打不开＝直接丢单） | ① 后端/数据库/Node 全在云端，**不受租户机器影响，不为此降版本**；② 最低基线锁 **Win10 22H2 + Edge**（微软承诺 Edge/WebView2 支持到 2028-10，无需 ESU）；③ `browserslist` + Vite `build.target` 锁 Chromium/Edge 111 级别并进 CI 校验；④ 不支持 IE11 与「兼容模式」，360/QQ 浏览器须切极速模式，写进入驻说明；⑤ 老机性能靠体积预算与克制动画，不靠降版本 | 见 `docs/decisions.md` **D56**；若实测仍有 IE11 用户，只能在入驻阶段强制引导升级（不做 IE 兼容） |

### 什么条件会推翻本推荐

诚实写明，避免「为推荐而推荐」：

1. 负责人或实际维护者**强 .NET 背景**，且更看重「单文件 exe 交付 + 原生 decimal + 编译期边界」→ 选 **B**。此时必须额外接受「两套语言 + 自建 3.1 生成器」的成本。
2. 团队以 **Python 数据/脚本能力**为主，且接受部署脆弱性 → 选 **C**。
3. 出现**必须原生移动端**（而非 Web 外壳）的硬需求 → 三套都不够，需重新评估（大概率变成「TS 后端 + Flutter/RN 前端」），这属于需求变更，不在本 ADR 范围。

**如果最终没选 A**：A 的这套「注册表驱动 REST/CLI/MCP/OpenAPI」设计**与语言无关**，仍应保留——它才是对 C4 的真正回答，换语言不该丢掉它。

---

## 未决项（需要负责人拍板）

> **2026-11-04 更新：U1-U5 已由负责人全部确认，结论落 `docs/decisions.md` **D55**（多租户共享表 + RLS / `numeric(18,6)` / UUIDv7 / Node 24 + pnpm 11 / 审计失败阻断业务）。U12 spike 仍待做（`platform` 写第一行业务代码前）。U6-U11 未拍板，按右列「拟定默认」执行，可随时改。**

| # | 问题 | 拟定默认（推荐） | 为什么必须现在定 | 影响 |
|---|---|---|---|---|
| U1 | **多租户隔离强度**：共享库共享表 + `tenant_id`，还是 schema-per-tenant / db-per-tenant？是否有大客户要求独立实例（与 D1 二期买断相关） | **共享表 + `tenant_id` + 复合索引 + 核心表 RLS 兜底** | 🔴 基本不可逆，改模型=全库迁移 | 全部表结构、索引、备份策略 |
| U2 | **金额与数量精度、舍入规则、舍入发生点**（单价/成本存几位？毛利在哪一步舍入？展示几位？） | 存储 `numeric(18,6)`，对外展示四舍五入到 2 位，**聚合与毛利用未舍入值**，仅在最终展示与对外契约边界舍入 | 🔴 一旦有数据，改精度=迁移+对账；直接影响 D5 成本、提成、结算 | 数据模型、契约金额字段、报表口径 |
| U3 | **主键方案**：UUIDv7 单键，还是 bigint 内部 + uuid 对外？ | **UUIDv7**（时间有序、可分布式生成、不暴露自增规模）；应用侧生成（PG 17 无内置 `uuidv7()`） | 影响所有表的索引与游标分页实现 | 数据模型、分页、外部引用 |
| U4 | **Node 版本统一**：本机 PATH 仍是 Node 18.20.8（EOL），是否统一切 24 LTS + pnpm 11？ | 统一 **Node 24 LTS + pnpm 11**（`engines` + `packageManager` 锁死） | 不确定就没人敢用新语法/新 API；双版本会导致 CI 与本地行为不一致 | 工程前置、CI 配置 |
| U5 | **审计写入失败时是否阻断业务** | **阻断**（返回 500 + 告警），因为 D51 要求全量；**不接受**「审计失败但业务成功」 | 决定了 outbox 追加器的错误语义 | 错误处理、可用性取舍 |
| U6 | **支付商户密钥托管**：一期自建 AES-256-GCM + 环境变量 KEK，还是直接上云 KMS？短信服务商选谁？ | 一期自建（更轻）；**KMS 与短信商留到部署决策** | 影响 D11 模式 A 的上线时间 | 安全实现、入驻流程 |
| U7 | **桌面端外壳**：Electron（单语言、生态成熟、体积大）vs Tauri（小、需 Rust） | **Electron**（一期不做桌面，二期再定也行） | 只在二期生效，**可以推迟**，但要在 ADR 里记一笔避免以后被当成已定 | 二期交付形态 |
| U8 | **前端是否要 SSR**（营销站/首屏） | **不要**（登录后应用，SPA 足够；营销站另起静态站） | 影响工程结构与部署复杂度 | 前端架构 |
| U9 | **CI 是否新增 `integration` job**（需改 `.github/workflows/test.yml`，超出本 ADR 的写范围） | 新增：ubuntu + `postgres:17` service 跑 L3 | 不新增则并发/锁类 bug 只能在本地发现 | CI 覆盖度、PR 门禁 |
| U10 | **CLI 分发方式**：先 `npx`/私有 registry，还是直接做单文件 exe（Windows 客户） | 一期 `npx` + 内部使用；给客户的 exe 二期再打 | 影响 CLI 的可用范围 | CLI 交付 |
| U11 | **本 ADR 的文档落位**：`docs/README.md` 索引表、`docs/roadmap.md`、`docs/decisions.md` 追加 D53——由谁改？ | **Lead 统一改**（本 ADR 只写自己这一个文件，符合写范围约束） | 不改索引，下个会话会找不到这份 ADR | 文档一致性 |
| U12 | **是否需要一次 2 小时 spike 验证**（Zod4→JSON Schema→OpenAPI 3.1 管线、PGlite 在 Windows 的可跑性、Fastify5 与 Drizzle 组合） | **建议做**（platform 开工前，产出 `docs/spike-0001-*.md` 记录结论） | 这两条管线是本推荐的技术命门，纸面正确 ≠ 实测可跑 | 推荐的可信度 |

> **U12 特别说明**：本 ADR 对 Zod 4 的 JSON Schema 导出能力、PGlite 在 Windows 的可运行性、Fastify 5 + Drizzle 的组合，均基于公开文档与既有实践，**未在本项目中实测**。若 spike 否证，方案 A 的「OpenAPI 3.1 构造化」优势会削弱，需重新评估是否退回 B/C 或改为「手写 OpenAPI 文档 + 测试校验」。

---

## 参考

### 本文直接引用的口径

- `docs/decisions.md`
  - **D1**（L17–L22 共 6 行）：对外 SaaS、云端单一形态、本地只读备份、一期不做在线支付/自助订阅、注册入企三合一
  - **D11**（L48、L52）：收款侧一期做客户在线支付、**模式 A**（企业自配商户号，平台只传指令与回调、不碰钱）
  - **D15**（L53）：「公司×岗位」绑定，权限取并集，数据可见范围 = 绑定公司集合
  - **D22**（L60）/ **D31**（L69）：N 单在途批次归发出方、可用量锁定、到货确认才转司解锁
  - **D44**（L82）：19 个功能域清单（决定权限引擎的笛卡尔规模：8 动作 × 19 功能域）
  - **D51**（L90）：操作日志全量、只追加、业务失败也记
  - **D52**（L91）：API-first、OpenAPI 3.1 唯一真源、CLI + MCP、`/api/v1` 统一约定
  - **D52.1**（L92）：AI 权限 = 员工当前权限 ∩ scope、每请求重算、审批只能人类
  - D4 / D27 / D50：8 动作、看价脱敏、个人覆盖三层（权限引擎的输入）

### 契约与工程文档

- `docs/轻单_接口契约第三批_v1_20261104.md`
  - §1 操作日志（24 个字段 + 只追加/失败也记/脱敏规则）→ 本文「审计中间件」
  - §2 API Token（哈希存储、scope ⊆ 创建人授权、每 token 限流 429）→ 本文「权限引擎」
  - §3 通用 API 约定（13 条）→ 本文「契约第三批 §3 逐条落地」
  - §4 CLI 与 MCP 映射（退出码 0/2/3/4/5、一工具一接口、薄客户端）→ 本文「CLI / MCP」
  - §5 四项开放项（日志读覆盖、保留期、危险动作边界、Token 粒度）→ 与本 ADR 的 U5/U6 相关，**仍需冻结**
- `docs/module-platform.md`：P0 范围、验收标准（L27–L39）、开放项（L24 明确「本模块开工前必须出 ADR」）
- `docs/project-context.md` §6（四端顺序与「不该写四遍」）、§8-3（技术栈未知，本 ADR 的回答对象）
- `docs/ONBOARDING.md` §4（8 模块分工、分支、依赖顺序、写范围约束）
- `AGENTS.md`：文档真源、开发约定（API-first / 审计 / AI 同权）、协作（一个 PR 一个写范围）、测试（`tests/run.ps1`、`.ps1` 补 BOM）
- `tests/run.ps1` + `.github/workflows/test.yml`：唯一测试入口与 windows/ubuntu 双平台矩阵（本文「测试策略」的衔接点）

### 本 ADR 明确未覆盖

- 接口字段与业务口径（以第一/二批契约为准；本 ADR 不改契约）
- 部署拓扑细节、云厂商选型、备案与数据驻留（属 U9/U6 与后续运维文档）
- 移动端离线同步协议（`docs/project-context.md` 明确「项目前完全没有材料」，留阶段 5）
- 买断版（二期）的部署与授权机制（D1 已把买断推到二期）
