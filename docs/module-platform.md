# 模块：platform（平台底座）

> 负责人：主线（负责人 + DSH 智能体团队）｜接手日期：2026-11-04

> 所属交付模块：**MAIN 主线**（负责人 + DSH 智能体团队）｜分支 `feat/main-platform`

> 阶段 4 的 P0 模块：其余 7 个业务模块都依赖它，先做完再并行。

## 目标

提供轻单的身份、权限与单据公共能力，让业务模块只写自己的业务，不各自重造租户隔离、授权、编号、状态机、审批和待办。

## 范围与页面

- **功能域（D44）**：员工、权限设置、公司管理。工作台与业务全流程图对全员开放，不单独设功能域（D44）。
- **页面**：1 登录/企业注册/入企、2 工作台、16 员工、17 权限设置、18 公司管理、19 业务全流程图、21 操作日志、22 API 与集成。
- **全局能力**：编号取号、权限引擎、审批框架、单据框架（单头三态 + 行过程态 + 取消级联）、待办（流转表）、打印/导出框架、单据链路视图（D18/D25）、**操作日志（D51）**、**API 层与 AI 集成（D52：OpenAPI/CLI/MCP/API Token/危险动作开关）**、平台运营后台（手动计费、企业停用，D1）。
- **实体**：企业（租户）、公司、员工、岗位、员工-公司-岗位、员工-权限覆盖、待办、流转表、操作日志、API Token。
- **不做**：订阅费在线支付/自助开通（D1，运营后台手动配置另立项）；微信授权（D23 二期）；员工档案（D6b 二期）。

## 依赖

- 上游：无（P0）。
- 下游：全部业务模块——只通过本模块公开的权限判定、取号、审批、状态机、待办接口调用，不直读这些表；**所有写操作必须调用本模块的审计写入**（D51），**所有业务能力必须同时暴露为 REST 接口**（D52，Web/CLI/MCP 共用）。

## 开放项

- **技术栈与多端收敛方式：已定**（`docs/decisions.md` **D53** + `docs/adr-0001-tech-stack.md`）：TypeScript 单一语言全栈（Node 24 LTS + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite），`packages/contracts` 一套 Zod 注册表发射 OpenAPI 3.1 / CLI / MCP；桌面 Electron、移动 Capacitor 均为外壳复用同一份前端。**D53 未随附的遗留项已于 2026-11-04 收口**：U1-U5 → **D55**（共享表 + tenant_id + 核心表 RLS / 金额 numeric(18,6) 全程不舍入 / UUIDv7 应用侧生成 / Node 24 + pnpm 11 / 审计失败即阻断）；U12 spike → **D57**（Zod4→OpenAPI 可用但需注册 id 后重写引用；PGlite 实测 PG 18；应用账号不得 superuser/BYPASSRLS）；Windows 10 兼容 → **D56**（锁浏览器基线，不降版本）。
- 运营后台（手动计费配置、企业停用，D1）纳入本模块：**平台侧操作也必须进操作日志**（D51）。
- **接口契约第三批（操作日志 + API Token + 通用 API 约定）：✅ 已冻结（2026-11-04）**。§5 四项、§7 十处缺口、§8 五问均已裁定，结论见 `docs/decisions.md` **D54**。开工时需按 D54 同步清掉 `docs/api/openapi.yaml` / `docs/api/cli.md` 里残留的「待 platform 冻结 / 提案」标记。

## 验收标准

- **登录闭环（一期口径已调整，见 D54④）**：后台/初始化脚本直接建企业与员工账号 → 手机号 + 验证码登录（开发与内测环境用固定验证码或后台直发；短信服务商上线前再定）→ 登出。**注册与入企三合一端点（邀请码/手机号白名单/老板预建）推迟到上线前**，D1 规则本身不变；手机号被其他企业占用时仍须拒绝并提示联系原企业（D14）。
- 权限三层生效：岗位并集 ⊕ 个人覆盖（D50）；数据可见范围 = 绑定公司集合（D15）；老板 = 租户级（D1）；经理不可改老板/财务/其他经理（D50）。
- 8 动作（查/建/编/审/出/删/看价/导）+ 界面两档（简单/高级）+ 功能域能力显隐（D4）；「看价」不进取勾选表格，单独配置（D4）。
- 编号并发安全：`类型字母-公司码(4)-日期(8)-流水(4，按月重置)`；工号定长 6 位全租户唯一（D16/D48）。
- 单头三态 + 行过程态；取消级联（无下游可取消、同事务回滚、逆向解锁、已完成一律走冲正，D21）；待办按流转表自动指派并自动关闭（D8）。
- 审计日志覆盖审批、成本更正、权限变更等关键动作；**平台、员工、AI 的写操作 100% 落日志，只追加、不可改删**（D51）。
- 操作日志独立追加：业务失败也留 `fail` 记录，不随业务事务回滚（D51）。
- API Token 可创建/撤销，scope 生效；**AI 的权限与绑定员工完全一致，不存在旁路**（D52）。
- **AI 权限不可放大（D52.1）**：scope ⊆ 创建人授权（超出拒绝创建）；员工岗位/个人覆盖/公司集合变更后下一次调用立即生效；员工停用 token 立即作废；审批只能人类，AI 不得审批自己发起的动作；审计同时记委托人与 AI 操作者。
- 危险动作（删除/冲正/成本更正/结算确认/权限变更）**默认拒绝 AI**，开关打开后仍走审批且必须带 reason（D52）。
- `GET /api/v1/openapi.json` 可产出且与实际接口一致；CLI 与 MCP 至少打通「登录态查看 + 一个写操作」并产生一致日志（D52）。

## 当前状态

🔄 **进行中**：**M1 核心可用（2026-11-04）**——`platform` 注册表里 10 个端点**全部实现**（不再有 501）：health / openapi.json / 登录 / 登出 / me / 操作日志查询 / API Token 建查撤 / 员工个人级权限覆盖写入。认证内核（会话 Cookie + Bearer、同源 CSRF、每请求现算权限、Bearer 优先）与 5 个跨 RLS 的 SECURITY DEFINER 函数已落地；`apps/api` 测试 46 → **97** 例全绿，全量门禁 `tests\run.ps1` `ALL PASSED (7 files)`。**未验证**：真实 PostgreSQL 18 实例（本地无 PG，只在 PGlite PG18 跑过）、CLI/MCP 端到端「登录→查看→写→审计落库」、production 的短信与 Secure Cookie 运行时路径。

## 已完成

- 模块边界、页面与功能域映射已登记（本文件 + `docs/README.md` 模块表）。
- **M0 骨架（2026-11-04）**：
  - **契约包**：22 个功能域 + 8 动作词表；11 个封闭错误码（HTTP ↔ CLI 退出码）；`packages/contracts` 的 Zod 注册表登记 10 个平台端点，`buildOpenApiDocument()` 发射 OpenAPI 3.1（实体注册 id、`$ref` 重写、`x-scope`/`x-audit`/`x-ai-policy`/`x-mcp-tool`），CI 断言「路径数 = 注册表端点数」「components.schemas = 注册实体数」。
  - **口径锁定测试（P0-2）**：`packages/contracts/src/spec-lock.test.ts` 把 D16 编号 / D50 三层 / D21 取消级联 / D51 审计 100% / D52.1 AI 不可放大 变成断言（不再只是文档存在性检查）。
  - **apps/api**：Fastify 5 + `X-Request-Id`(UUIDv7, ALS) + 统一错误体 + 安全头；路由**只从注册表生成**（health/openapi.json 已实现，其余 501）；纯 SQL 前向迁移 `0001_platform_core.sql`（13 张表、`numeric(18,6)` 金额域、`qingdan_app` 普通角色 + 11 张表 ENABLE/FORCE RLS + `tenant_isolation`、`audit_log` 只授 INSERT）；审计 outbox 追加器（失败即阻断）、并发安全取号（类型 × 年月键）、权限判定一条 SQL（岗位并集 ⊕ 个人覆盖，老板短路，token scope 交集）；PGlite(PG18) 上 43 个用例绿。
  - **apps/web**：React 19 + Vite + Tailwind 4 + TanStack Router/Query；22 页路由壳（对齐 `prototype-v0` 页 1-22）；api client（统一错误体）；D56 浏览器基线（`build.target=['chrome111','edge111']` + browserslist）。
  - **packages/cli / packages/mcp**：同一注册表生成命令树（`qingdan <domain> <action>`，退出码按 D54）与 MCP 工具表（`qingdan_<operationId>` 1:1，危险动作默认拒绝/可配走审批）。
  - **测试与 CI**：`tests/testbase.test.ps1`（P0-1 底座自检：BOM + Exit-Test）、`tests/workspace.test.ps1`（`pnpm -r build/test` 门禁）、`tests/platform-spec.test.ps1`（P0-2 包装）；CI 双平台加 Node 24 + pnpm 11 + `pnpm install --frozen-lockfile`，新增 ubuntu + `postgres:18` 集成 job（**PR #1 三个 job 实测全绿**：windows 1m31s / ubuntu 1m22s / integration 45s）。
- **M1 核心可用（2026-11-04，D59）**——10 个 platform 端点全部实现：
  - **迁移 `apps/api/migrations/0002_platform_m1.sql`**（纯前向）：① 审计只读视图 `audit_log_view`（属主权限视图 + 显式租户谓词，`qingdan_app` 只授 SELECT，基表仍只授 INSERT）；② `auth_find_login(phone)`（登录时无租户上下文，跨 RLS 查找）；③ `auth_resolve_session` / `auth_resolve_api_token`（凭证解析跨 RLS）；④ `audit_append_unscoped`（无租户上下文的失败登录日志，强制 `tenant_id IS NULL`）；⑤ `api_token.version` / `employee.version`（ETag 乐观锁）。全部 `SECURITY DEFINER` + `SET search_path = pg_catalog, public` + `REVOKE ALL FROM PUBLIC`。
  - **认证内核 `apps/api/src/platform/auth/`**：`session-store.ts`（令牌 32 字节随机、库里只存 sha256、闲置 7 天滑动续期、`last_seen_at` 每 5 分钟最多写一次）、`principal.ts`（**Bearer 优先**，Bearer 失败不回退 Cookie；token scope 与员工权限取交集）、`plugin.ts`（公开路由豁免、Cookie + 非安全方法同源 Origin/Referer 校验 → 403）、`cookie.ts`（无新依赖；production 才加 `Secure`）、`tenant-context.ts`（同连接 `set_config('app.tenant_id')` 的事务边界）。
  - **端点用例 `apps/api/src/modules/platform/usecases/`**：login（production 返 501 不静默放行 / 非生产固定验证码 / 未知手机号与非在职统一 401 防枚举 + 下发 HttpOnly Cookie）、logout（幂等 + 清 Cookie）、me（scope/companyIds/displayName）、api-tokens（scope ⊆ 创建人授权，超出直接 403 不裁剪；明文只返回一次；强 ETag + `If-Match`，缺失 428、不匹配 409；敏感读必记审计）、audit-logs（只读 `audit_log_view`、`(occurred_at,id)` keyset 分页、查询本身写一条敏感读审计）、permission-overrides（`permission.update` 闸门、经理不可改老板/经理/财务 → 403、差异项写入并与岗位基线一致项删除、dryRun 只校验不落库但打 `dry_run=true` 审计、`employee.version` 自增）。
  - **审计**：`writer.ts` 增 `recordAudit(db, event)`（有租户走 outbox → flush，失败抛出；无租户走 `audit_append_unscoped`）；`withAudit` 在有 `tenantId` 时先设 `app.tenant_id`，否则 FORCE RLS 下业务 + outbox 写不进。
  - **测试**：`apps/api` 46 → **97** 例（新增 51：会话存储 7 / 认证主体 9 / 插件 8 / DB 函数 4 / 登录闭环 9 / Token 6 / 审计查询 2 / 权限覆盖 6）；`pnpm -C apps/api test` 与全量 `tests\run.ps1`（`ALL PASSED (7 files)`）均绿。


## 进行中

- **M1 已完成的部分（2026-11-04）**：登录 / 登出 / me、API Token 建查撤、操作日志查询、员工个人级权限覆盖写入；认证内核与迁移 `0002_platform_m1.sql`。详见「已完成 · M1」。
- **M1 剩余（下一段）**：CLI/MCP 端到端冒烟（登录 → 查看 → 一个写操作 → 审计落库，需真实 PostgreSQL 或 CI 的 postgres:18 job）；`apps/web` 登录页与 22 页壳接真实接口；开发者后台（`/api/v1/admin/**`，D54⑤）与运营后台手动计费（D1）尚未开工；单据框架 / 审批 / 待办属 platform 范围但排在 business 模块前面单独一段。

## 下一步

- **M1-F 端到端**：在 CI 的 `postgres:18` job 上跑「CLI 登录 → `/auth/me` → 一次写操作 → 查审计有记录」，把它变成 `tests/platform-e2e.test.ps1` 的断言（本机无 PG，只能放 CI 或等本地装 PG 18）。
- **M1-G 前端接线**：`apps/web` 登录页 + 会话态 + 统一错误体；赖皓妍（UI）接手视觉前，先把路由壳接上真实接口。
- **M1-H**：开发者后台 `/api/v1/admin/**`（平台方跨租户，`actorType=platform`，账号独立体系，D54⑤）与平台级审计（`tenant_id IS NULL` 行目前只写不读）。
- 待裁决已清零：原三条（审计读权限 / 单号时区与取号粒度 / `is_owner` 字段）已由 **D59** 一次性裁定并落地。

## 已知问题 / 坑

- 个人覆盖的**写权限边界**最易写错（经理可改普通员工、不可改老板/财务/其他经理，D50）：先写测试再写实现。
- 「看价」是数据可见性不是操作（D4）：别塞进动作表格；金额字段的兜底过滤要全链一致（D27 损失金额同口径）。
- 流水号按月重置：跨月 0 点并发取号必须有用例。
- 权限基础在 platform，但每个业务模块的「动作→接口」映射各自实现：接口鉴权只认 platform 的判定结果，不认前端传的菜单。
- **审计表只授 INSERT 与「日志查询」天然冲突**（M0 实测）：已由 **D59①** 收口——基表仍只授 INSERT，另建属主权限视图 `audit_log_view`（显式租户谓词）。**别再给基表授 SELECT，也别把视图改回 `security_invoker`**：`security_invoker` 视图以调用者权限读基表，`qingdan_app` 没有基表 SELECT 就会 `permission denied`（2026-11-04 实测踩坑）。
- **`0002_platform_m1.sql` 在 M1 期间是「可追加的未发布迁移」**：本机与 CI 只用 PGlite 每次新建库，没有持久库应用过它，所以 M1-A~E 的增量都追加在同一个文件里。**一旦某个环境真正部署过 0002，就停止改写它、改用新的 0003+**（迁移 runner 记录已执行文件，改写历史文件会让 checksum/顺序失效）。
- **迁移里 5 个 SECURITY DEFINER 函数是「跨 RLS 的最小开口」**：只返回解析所需列、只 `GRANT EXECUTE TO qingdan_app`、固定 `search_path`。新增同类函数必须照此办理，禁止为了省事给应用角色加跨租户 SELECT。
- **RLS 只在非 superuser 下成立**（D57 ③）：本地测试必须 `set role`，生产连接账号不得是 superuser / BYPASSRLS，否则隔离形同虚设。
- **取号允许跳号**（N3①）：事务回滚会留下空洞，属已接受口径；不要为「连续」加锁表。

## 相关文件

- 口径：`docs/decisions.md`（D1/D4/D8/D13/D14/D15/D16/D21/D44/D48/D50）
- 契约：`docs/轻单_接口契约第一批_v1_20261103.md` §1/§2/§10
- 原型：`docs/prototype-v0.md` §1/§2/§3
- 原型页面：`prototype.html`
