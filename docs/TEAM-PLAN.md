# 轻单 · 协作开发计划（1 条 AI 开发线 + 4 位人类开发者）

> **读者**：项目负责人（你）、DSH 智能体团队（我 + 子 Agent）、4 位人类协作开发者。
> **配套**：`docs/ROLES-AND-BOUNDARIES.md`（谁能做什么/不能做什么、灰区审批、文件级写权限）、`docs/ONBOARDING.md`（接入流程）、`docs/DEV-SETUP.md`（环境与目录）、各模块 `docs/module-<模块>.md`。
> **模型**：你做「你的模块」，用 DSH 智能体团队开发；另外 4 位人类开发者做其余模块。**两类开发线在同一个仓库、同一套契约、同一套 CI 与 PR 规则下并行**。
> **状态**：2026-11-04 起草；模块归属与 4 位同事姓名待填（§8），技术栈待 D53 拍板。

---

## 0. 一页纸看懂

| 开发线 | 谁 | 默认负责模块 | 分支 |
|---|---|---|---|
| **AI 线** | 负责人 + DSH 智能体团队（Lead 统一提交） | `platform`（P0 地基）+ `test` 底座 | `feat/platform` |
| **人类线 1** | 人类开发者 1 | `masterdata` + `purchase` | `feat/masterdata`、`feat/purchase` |
| **人类线 2** | 人类开发者 2 | `inventory` + `processing` | `feat/inventory`、`feat/processing` |
| **人类线 3** | 人类开发者 3 | `sales` + `internal-trade` | `feat/sales`、`feat/internal-trade` |
| **人类线 4** | 人类开发者 4 | `settlement`（含利润报表） | `feat/settlement` |

为什么默认把 `platform` 给 AI 线：它是**唯一硬前置**（登录/权限/编号/审计/审批/单据框架/待办/API 层），谁先交付谁解锁其他所有人；同时它是共享写范围，交给一条线独占能避免 4 个人同时改公共层。
**这个默认不是定死的**：你想做哪个模块都可以换（§8-1），换完我把表改掉。

## 1. 模块与写范围（互斥）

| 模块 | 开发线 | 写范围（代码/文档） | 硬依赖 |
|---|---|---|---|
| `platform` | AI 线 | `apps/api/src/platform/**`、`packages/contracts/**`、`docs/module-platform.md` | 无（P0） |
| `test` | AI 线 | `tests/**`（`run.ps1` 不改）、`docs/module-test.md` | 无 |
| `masterdata` | 人类 1 | `apps/api/src/modules/masterdata/**`、`apps/web/src/pages/masterdata/**`、`docs/module-masterdata.md` | platform |
| `purchase` | 人类 1 | 同上（purchase）、A 单与 S 退货接口 | platform、masterdata、inventory |
| `inventory` | 人类 2 | 批次/库存/流水/盘点与成本更正 | platform、masterdata |
| `processing` | 人类 2 | B 单、损耗、损失记录 | platform、masterdata、inventory |
| `sales` | 人类 3 | E 单、收款、在线支付、R 客户退货 | platform、masterdata、inventory |
| `internal-trade` | 人类 3 | N 单、内部定价、在途锁定/转司 | platform、masterdata、inventory |
| `settlement` | 人类 4 | C 单、提成、利润报表 | sales、processing、internal-trade |

**规则**：
- 一条线同一时间只推**一个模块**，另一个模块的分支可以空着；避免自己两个分支互相 rebase。
- **跨线改动**（`packages/contracts`、`apps/api/src/platform`、数据库迁移、AGENTS/decisions）必须先在 Issue 声明 + PR 列出受影响模块，不能直接改。
- 代码目录与表前缀按模块隔离；**禁止跨模块 import、禁止直读别人的表**（ESLint + 评审双重检查）。

## 2. AI 线与人类线怎么协作（这是新增的关键部分）

| 事项 | AI 线 | 人类线 |
|---|---|---|
| 分支 | `feat/platform`（一个模块一条） | `feat/<模块名>` |
| 提交 | 由 Lead 统一提交并推送（子 Agent 只写文件不提交） | 自己提交并推送 |
| PR | Lead 开 PR，**至少 1 位人类评审**（涉及契约/权限/审计必须） | 自己开 PR，Lead 或另一位人类评审 |
| 合并 | CI 绿 + 1 approve | 同左 |
| 契约包 | AI 线维护 `packages/contracts`，人类可提 PR 改 | 只能提 PR，不能直接改 |
| 每日同步 | Lead 在 Issue/群里贴「分支 + 提交 + 测试结果」 | 每日 15 分钟文字同步 |
| 阻塞 | 4 小时无解升级到 Lead | 同左；口径问题找 Lead 拍板 |

**人机互评是强制的**：平台层的任何改动（权限、审计、编号、单据框架）都要人类评审一次——人类是"第二双眼睛"，避免 AI 团队自己写、自己信。

## 3. 依赖顺序（谁能先动、谁必须等）

```
platform ──► masterdata ──► inventory ──► purchase ──┐
     │                        │              processing ─┼──► settlement
     │                        └──────────────► sales ───┘
     └──────────────────────────────────────► internal-trade ──► settlement
```

- **platform 是唯一硬前置**：AI 线交付「权限判定 + 编号 + 审计 + 单据框架 + contracts 包」之前，人类线**不写业务代码**，只做 §4 的准备。
- settlement 等 sales/processing/internal-trade 的接口稳定后再开。

## 4. 第 1 周（所有人都有活儿，不互相等死）

**AI 线（Lead）**
- 建骨架：`apps/api`、`apps/web`、`packages/contracts|cli|mcp`、`pnpm-workspace.yaml`、tsconfig、ESLint（含跨模块 import 拦截）。
- 先发 `packages/contracts` 的「动作枚举 + 错误码 + 金额类型 + 路由注册表」，handler 可以先 501。
- 写权限判定的 SQL 与 `ctx.authz`；审计写入（outbox + 追加器）第一版。
- 把 api-designer 报的 10 处契约缺口补进第三批契约并申请冻结。

**人类 1**：读契约第一批 §2（主数据）与 §3.1/§4；产出 masterdata 字段表、校验规则、OpenAPI 片段；下周直接进 masterdata。
**人类 2**：读 §7/§8（批次/流水）与 §3.2（B 单）；把「可用量四列 / 提交占用 / 取消释放 / 出库转已引用」写成状态机表与测试用例清单（含并发）。
**人类 3**：读 §3.3/§3.4/§6（E/C/收款）；把「改价下限按行」「仅退款两型重算」「提成快照」写成 Given/When/Then；确认 R 单与 C 单重算的接口边界。
**人类 4**：读 §3.4/§9 与 D35/D40/D43；把 C 单的「本单相关损失 / 净毛利 / 未归属损失下钻」写成计算规则表；顺便认领打印/导出框架的版式需求。

第 1 周末：Lead 主持 1 小时评审，确认 contracts 签名与四人用例清单，之后接口尽量不再变。

## 5. 里程碑（按 5 条线并行重排）

| 里程碑 | 目标 | 主责 | 验收 |
|---|---|---|---|
| **M0（第 0 周）** | 前置清空 | Lead | D53 拍板、契约第三批冻结、骨架可 `pnpm install && pnpm -r build`、`tests/run.ps1` 绿 |
| **M1（第 1 周）** | platform 核心可用 | AI 线 | 登录/权限三层/编号/审计/审批骨架/单据框架/待办；`GET /api/v1/openapi.json` 可访问 |
| **M2（第 2 周）** | 主数据 + 库存基础 | 人类 1、2 | masterdata CRUD + 默认售价；批次入库/四列/流水/盘点 |
| **M3（第 3 周）** | 单据主链 | 人类 1、2 | A → 批次 → B → 新批次 全链路 |
| **M4（第 4 周）** | 销售与收款 | 人类 3 | E 单 + 收款记录 + 在线支付 + R 退货 |
| **M5（第 5 周）** | 内部交易 + 结算 | 人类 3、4 | 跨公司调货闭环；C 单与手工核算一致 |
| **M6（第 6 周）** | 报表 + 打印 + 集成 | 人类 4 + AI 线 | 利润报表下钻、两套版式、CLI/MCP 端到端 |
| **M7（第 7 周）** | 联调验收 | 全员 | 端到端用例、部署、只读备份、验收签字 |

> 按全职估；兼职按比例顺延，里程碑顺序不变。

## 6. 开工就绪（DoR）

- [ ] 模块检查点已认领（写负责人与日期）
- [ ] 该模块「开放项」已拍板并追加 `docs/decisions.md`
- [ ] 依赖模块的接口已在 `packages/contracts` 里有签名（可以是 501 实现）
- [ ] 契约章节已冻结（第一/二批已冻结；第三批待冻结）
- [ ] 页面描述在 `docs/prototype-v0.md` 里

## 7. 完成定义（DoD）

- [ ] 模块检查点「验收标准」逐条通过
- [ ] `tests/<模块>.test.ps1` 全绿，覆盖契约里的每条规则
- [ ] 端点都在 OpenAPI 里，且实际响应能过 schema 校验（双向断言）
- [ ] 所有写操作产生操作日志（D51），AI 调用带 token/来源/reason
- [ ] 权限按 D4/D15/D50/D52.1 服务端判定；AI 不能拿到比人更大的权限
- [ ] 无跨模块 import、无直读他人表
- [ ] PR 已评审合并，`main` 上 `tests/run.ps1` 绿
- [ ] `docs/roadmap.md` 与模块检查点已更新

## 8. 当前阻塞与待你拍板

| # | 事项 | 需要谁 | 状态 |
|---|---|---|---|
| 1 | **AI 线做哪几个模块**（默认 platform + test，可换） | 你 | 🟡 待确认 |
| 2 | 4 位人类同事的姓名 + 各自模块 | 你 | ⬜ 待填 |
| 3 | 技术栈 D53（ADR 推荐 TS 全栈；U1 租户隔离 / U2 金额精度 / U3 主键 是不可逆项） | 你 | 🟡 待拍板 |
| 4 | 契约第三批冻结（API 骨架已发现 10 处缺口/矛盾，见 `docs/api/openapi.yaml` 报告） | Lead + AI 线 | 🟡 待补 |
| 5 | 代码骨架（apps/packages） | AI 线 | ⬜ M0 |
| 6 | D51①② / D52①② 四个默认值 | 你 | 🟡 有默认值可直接开工 |

## 9. 沟通物放在哪

- 口径：`docs/decisions.md`（唯一真源，只追加）
- 契约：`docs/轻单_接口契约第一批/第二批/第三批`
- 进度：`docs/module-<模块>.md` + `docs/roadmap.md`
- 任务板：GitHub Issues（label：`module:<名>`、`line:ai` / `line:human1..4`、`blocked`、`needs-decision`）
- 环境：`docs/DEV-SETUP.md`；接入：`docs/ONBOARDING.md`
