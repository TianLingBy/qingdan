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

🔄 **进行中**：**M0 工程骨架已建立（2026-11-04）**——monorepo（`apps/api`、`apps/web`、`packages/contracts|cli|mcp`）、契约注册表发射 OpenAPI 3.1、CLI 命令树、MCP 工具表、迁移与审计/取号/权限判定内核、CI 双平台全部打通（全量门禁 `tests\run.ps1` 绿）。**业务端点仍全部返回 501**：登录、会话、Token、审计查询、权限覆盖写入尚未实现（M1 范围）。

## 已完成

- 模块边界、页面与功能域映射已登记（本文件 + `docs/README.md` 模块表）。
- **M0 骨架（2026-11-04）**：
  - **契约包**：22 个功能域 + 8 动作词表；11 个封闭错误码（HTTP ↔ CLI 退出码）；`packages/contracts` 的 Zod 注册表登记 10 个平台端点，`buildOpenApiDocument()` 发射 OpenAPI 3.1（实体注册 id、`$ref` 重写、`x-scope`/`x-audit`/`x-ai-policy`/`x-mcp-tool`），CI 断言「路径数 = 注册表端点数」「components.schemas = 注册实体数」。
  - **口径锁定测试（P0-2）**：`packages/contracts/src/spec-lock.test.ts` 把 D16 编号 / D50 三层 / D21 取消级联 / D51 审计 100% / D52.1 AI 不可放大 变成断言（不再只是文档存在性检查）。
  - **apps/api**：Fastify 5 + `X-Request-Id`(UUIDv7, ALS) + 统一错误体 + 安全头；路由**只从注册表生成**（health/openapi.json 已实现，其余 501）；纯 SQL 前向迁移 `0001_platform_core.sql`（13 张表、`numeric(18,6)` 金额域、`qingdan_app` 普通角色 + 11 张表 ENABLE/FORCE RLS + `tenant_isolation`、`audit_log` 只授 INSERT）；审计 outbox 追加器（失败即阻断）、并发安全取号（类型 × 年月键）、权限判定一条 SQL（岗位并集 ⊕ 个人覆盖，老板短路，token scope 交集）；PGlite(PG18) 上 43 个用例绿。
  - **apps/web**：React 19 + Vite + Tailwind 4 + TanStack Router/Query；22 页路由壳（对齐 `prototype-v0` 页 1-22）；api client（统一错误体）；D56 浏览器基线（`build.target=['chrome111','edge111']` + browserslist）。
  - **packages/cli / packages/mcp**：同一注册表生成命令树（`qingdan <domain> <action>`，退出码按 D54）与 MCP 工具表（`qingdan_<operationId>` 1:1，危险动作默认拒绝/可配走审批）。
  - **测试与 CI**：`tests/testbase.test.ps1`（P0-1 底座自检：BOM + Exit-Test）、`tests/workspace.test.ps1`（`pnpm -r build/test` 门禁）、`tests/platform-spec.test.ps1`（P0-2 包装）；CI 双平台加 Node 24 + pnpm 11 + `pnpm install --frozen-lockfile`，新增 ubuntu + `postgres:18` 集成 job。

## 进行中

- **M1（下一步）**：登录闭环（后台建号 + 手机号/验证码 + 会话 Cookie）、会话解析、API Token 增删查、审计查询端点、权限覆盖写入（`PATCH /employees/{id}/permissions`）——即把 10 个已登记端点的 501 逐个换成真实用例。

## 下一步

- 按 `docs/TEAM-PLAN.md` §5 第 1 周：把 `ctx.authz`（权限判定）接到 HTTP 层，实现登录/会话/Token 三个闭环，跑通「CLI 登录 → 查看 → 一个写操作 → 审计落库」端到端。
- 待裁决：① 审计查询端点的读权限（当前 `audit_log` 对应用角色只授 INSERT，需定只读视图或专角色）；② 单号日期/月键时区（N2，当前 UTC）与取号粒度（N1 候选①、允许跳号 N3①）；③ 老板判定字段 `employee.is_owner`（domain-model §1.3 仍标 ⬜）。

## 已知问题 / 坑

- 个人覆盖的**写权限边界**最易写错（经理可改普通员工、不可改老板/财务/其他经理，D50）：先写测试再写实现。
- 「看价」是数据可见性不是操作（D4）：别塞进动作表格；金额字段的兜底过滤要全链一致（D27 损失金额同口径）。
- 流水号按月重置：跨月 0 点并发取号必须有用例。
- 权限基础在 platform，但每个业务模块的「动作→接口」映射各自实现：接口鉴权只认 platform 的判定结果，不认前端传的菜单。
- **审计表只授 INSERT 与「日志查询」天然冲突**（M0 实测）：`audit_log` 只给 `qingdan_app` INSERT 是 D51「不可改删」的物理保证，但 `GET /audit-logs` 需要读——M1 需定口径（专用只读角色 / 只读视图 / 单独审计库），不要在这一步把 UPDATE/DELETE 授回去。
- **RLS 只在非 superuser 下成立**（D57 ③）：本地测试必须 `set role`，生产连接账号不得是 superuser / BYPASSRLS，否则隔离形同虚设。
- **取号允许跳号**（N3①）：事务回滚会留下空洞，属已接受口径；不要为「连续」加锁表。

## 相关文件

- 口径：`docs/decisions.md`（D1/D4/D8/D13/D14/D15/D16/D21/D44/D48/D50）
- 契约：`docs/轻单_接口契约第一批_v1_20261103.md` §1/§2/§10
- 原型：`docs/prototype-v0.md` §1/§2/§3
- 原型页面：`prototype.html`
