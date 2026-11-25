# 前端改造规范边界（v3.0 · 2026-11-24 修订）

> 负责人裁定（2026-11-24 17:20）：**实现目标改为新 UI v3.0**（`design/v3.0/`），原「逐页套 v0.13」的表述作废。
> 后端仍**完全冻结**（`docs/BACKEND-FROZEN.md` 第七节，CI `backend-frozen` 直接红），前端不改 IA、不新增页面、不要求新后端能力。
> 这份文件是派活与验收的唯一口径，issue 里只引用它，不重复抄。
>
> 设计侧三份必读（都在 `design/v3.0/`）：
> - `index.html` —— 稿子本体（单文件、零构建，22 页 + 登录 + 入企 + 打印客户联 + 亮暗双模）
> - `四态与组件对照-给repo.md` —— 四态 DOM 写法、分页、图标、已知差异
> - `后端对齐清单.md` —— 24 域 × **11** 动作、cap 真名、后端没有的按钮

## 一、你改什么、不改什么

| 路径 | 权限 | 说明 |
| --- | --- | --- |
| `apps/web/src/pages/**` | **可以改** | 本次主体：页面结构、状态、文案、样式 |
| `apps/web/src/components/**` | **可以改** | 公共组件、页面内子组件、图标 |
| `apps/web/src/styles/**`、Tailwind 配置 | **可以改** | 允许新增 `app-v30.css`（把 `design/v3.0/index.html` 的样式成体系搬进来），禁止新建第二套令牌体系 |
| `apps/web/src/lib/**`（除 `api.ts` 的接口签名） | 可以改 | 纯前端工具 |
| `apps/web/**/*.test.tsx` | **必须改** | 改页面就要让测试跟着绿，不许删断言 |
| `apps/api/**`、`packages/contracts/**`、`apps/api/migrations/**`、`docs/api/openapi.yaml`、`apps/cli/**`、`apps/mcp/**` | **不许碰** | 后端已完全冻结，CI `backend-frozen` 直接红 |
| `design/v3.0/**` | 只读 | 稿子是验收基准，不许为了让代码过而改稿 |
| `docs/api/feature-matrix.md` | 不许手改 | 生成物，`node tools/gen-feature-matrix.mjs` 重生成 |
| `docs/**` 其它 | 可以改 | 页面说明、UI 记录随 PR 一起提 |

改页面时**不重写 IA**：`apps/web/src/router/routes.ts` 与 `docs/prototype-v0.md` §2 已锁死 22 页与路径，不新增页面、不改 path、不合并分栏。

## 二、22 页清单（就是 `routes.ts` 那 22 条，不多不少）

| # | 页面 | path | 现状文件 |
| --- | --- | --- | --- |
| 1 | 登录 / 入企 | `/login` | `pages/auth/` |
| 2 | 工作台 | `/workbench` | `pages/workbench/WorkbenchPage.tsx` |
| 3 | 采购单 A | `/purchase-orders` | `pages/purchase/PurchaseOrdersPage.tsx` |
| 4 | 加工单 B | `/processing-orders` | `pages/processing/ProcessingOrdersPage.tsx` |
| 5 | 销售单 E | `/sales-orders` | `pages/sales/SalesOrdersPage.tsx` |
| 6 | 内部交易单 N | `/internal-trades` | `pages/internal-trades/InternalTradeOrdersPage.tsx` |
| 7 | 结算单 C | `/settlements` | `pages/settlements/SettlementsPage.tsx` |
| 8 | 冲正单据 R/S/I | `/reversals` | `pages/reversals/*Panel.tsx` |
| 9–12 | 商品 / 客户 / 供应商 / 加工厂 | `/products` `/customers` `/suppliers` `/processors` | `pages/masterdata/MasterdataPage.tsx` |
| 13 | 库存数量 | `/inventory` | `pages/inventory/` |
| 14 | 库存流水 | `/inventory-flows` | 同上 |
| 15 | 盘点 | `/stocktakes` | `pages/reversals/StocktakesPanel.tsx` |
| 16 | 员工 | `/employees` | `pages/employees/EmployeesPage.tsx` |
| 17 | 权限设置 | `/permissions` | `pages/permissions/PermissionsPage.tsx` |
| 18 | 公司管理 | `/companies` | `pages/companies/CompaniesPage.tsx` |
| 19 | 业务全流程图 | `/flow` | 现有页 |
| 20 | 利润报表 | `/profit-report` | 现有页 |
| 21 | 操作日志 | `/audit-logs` | `pages/audit/AuditLogsPage.tsx` |
| 22 | API 与集成 | `/api-integration` | `pages/api-integration/ApiIntegrationPage.tsx` |

## 三、样式规则（怎么算「照 v3.0 做完了」）

1. **视觉以 `design/v3.0/index.html` 为准**：布局、间距、字号、颜色、圆角、亮暗双模逐页对上。稿子不是参考意见，是验收基准。
2. **样式落地方式**：把稿子里的样式成体系搬进 `apps/web/src/styles/app-v30.css`（一次 PR 完成，不要一页一个片段），页面只引类名。
   - 复用 `app-v013.css` 已有的：`panel`、`card`、`btn` 家族、`chip`、`crumb`、`table`、`pager`、`sk`（骨架）、`r-row`、`st-tr`、`st-block`
   - 稿子新引入、repo 里**还没有**的：`list-card`、`.tf`（列表页脚条）、`lg-form` / `lg-alert`（登录表单）—— 这些进 `app-v30.css`
   - 禁止：行内 `style=`、新造 CSS 变量名、新引 UI 库 / 图标库 / CSS-in-JS
3. **图标**：稿子里共 **23 枚**图标（`四态与组件对照-给repo.md` §五：`pg-first`/`pg-prev`/`pg-next`/`pg-last`/`clock`/`trend`/`trash`/`pencil`/`key`/`shield`/`refresh`/`calendar`/`filter`/`arrow-in`/`arrow-out`/`adjust`/`ticket`/`check`/`undo`/`copy`/`star`/`pin`/`split`）按现有 `viewBox="0 0 24 24"`、`stroke=currentColor`、`stroke-width=1.6`、默认 18px 的规范进图标组件，不许引图标库。
4. **主题默认值**：`apps/web/src/main.tsx` 已写 `document.documentElement.dataset.mode = 'light'`（`tokens-v013.css` 的 `:root` 默认是暗色，浅色只在 `html[data-mode="light"]` 下）。**页面里不要再各自设置 `data-mode`**，将来接主题开关时只改这一处；也不要在页面上写暗色专用样式。

## 四、四态与权限态（硬性）

1. **四态取值 = `filled` / `empty` / `loading` / `error`**（不是 `ok`）。状态从 `apps/web/src/lib/list-state.ts` 的 `resolveListState({ isPending, hasError, isEmpty })` 来，优先级 loading → error → empty → filled。
2. **四分支常驻 DOM，切换只改属性**，不许 JS 条件渲染：
   - 列表页：`data-state` 挂 `<tbody>`，数据行 `className="r-row"`，三个占位行 `className="st-tr st-empty|st-loading|st-error"`（写法见 `design/v3.0/四态与组件对照-给repo.md` §一.1）。好处：表头不消失、列宽不塌。
   - 面板页：`data-state` 挂容器，四个分支 `<div className="st-block st-filled|st-empty|st-loading|st-error">`。
   - 登录表单：`<form data-state="idle|loading|error">`，`.lg-alert` 只在 error 分支显示。
3. **权限三态**用 `allows(scope, domain, action)` 判定（`apps/web/src/lib/access.ts`）：
   - 有权限：可点，`title="执行「X」· 需要 <domain>.<action> 权限"`
   - 无权限：`disabled` + `title="需要 <domain>.<action> 权限"`
   - 状态不允许：`disabled` + 写明原因
   - 不该看的整块：不渲染
4. **绝不按职位判权**（不写 `role === 'finance'`、`isManager`、`isAdmin`）。只有 scope。
5. **cap 名字一律以 `packages/contracts/src/domains.ts` 为准**（24 域 × **11** 动作：`read` `read_all` `create` `update` `approve` `ship` `delete` `merge` `view_price` `view_handler` `export`）。设计稿里沿用的早期写法（`purchase_order.ship`、`apikey.create`、`reversal.create`、`inventory.adjust`…）**一律改成契约真名**（`purchase.ship`、`api_integration.create`、`customer_return.create`、`inventory_qty.update`…）。逐条对照表见 `design/v3.0/后端对齐清单.md` §二。
6. **没看价权限时后端根本不返回 `totalAmount` 键**，界面显示占位「—」，不许用 `0` 顶替。
7. **工作台版式：完全照 v3.0 稿子做，不保留入口卡片区**（2026-11-24 负责人拍板，替代 2026-11-20 的「入口卡片矩阵」写法）：
   - 版式照 `design/v3.0/index.html` 的 `PG.workbench` 五块：顶部 KPI 区（4 张卡）→ 待办事项 → 主业务链路（A→B→E→C 直达）→ 近 6 个月毛利趋势 → 最近动态（审计日志前 5 条）。
   - **KPI 与链路卡片一律按权限「整块不渲染」，不留「—」「已脱敏」这类占位**：无 `sales.read` 不显示「本月销售总额」「在途/待签收」；**无 `view_price` 时销售额卡整块不显示**（不是显示脱敏文案）；无 `inventory_qty.read` 不显示「可用库存」；无 `profit_report.read` 不显示「综合毛利率」与趋势图；无 `audit_log.read` 不显示「最近动态」。四张 KPI 全无权限时，该行整个 `<div class="kpis">` 不渲染。
   - 待办走真接口 `GET /api/v1/todos`（`workbench.todos.read`），空态照稿子「全部处理完了」走 `data-state="empty"`。
   - 老 `apps/web/src/pages/workbench/WorkbenchPage.tsx` 的入口卡片区（`servedEntries()` 渲染那块）在本页删除；`apps/web/src/lib/access.ts` 的 `servedEntries()` 保留（其他地方仍可用），但工作台不再调用。

## 五、能调什么接口

1. 只用 `docs/api/feature-matrix.md` 里的 152 个端点（含每个端点的权限动作与 `If-Match`）。**不许新增后端接口、不许改契约。**
2. 「后端没有、不许画」清单是硬边界：销售单审批环节、任何物理删除单据、批量操作、附件上传、打印 PDF、除 `profit_report` / `commission` 外的统计图表。稿子已按这条改过（盘点删除只在待审批态且属 `stocktake.delete` 真端点；密钥没有「重发」；日志没有「导出」）。
3. 列表/导出的 `?scope=mine|all` 已由后端实现，前端只接线；没有 `read_all` 权限时不显示「看谁的」开关。
4. **写端点带乐观锁**：前端从上次 GET 的响应头取 etag，写请求带 `If-Match`。
5. 分页参数是后端真名 `page` + `pageSize`；「共 N 条 · 合计」按全部筛选结果算，不是当前页；`filled` 之外隐藏分页控件。
6. 那 22 个「后端就绪、前端没接」的端点**不在本次范围**（见 #425）。

## 六、验收口径（每页合并前必须过）

```powershell
pnpm -C apps/web exec tsc --noEmit                      # 类型干净
pnpm -C apps/web exec vitest run <本页测试文件>          # 至少本页测试绿
pnpm -r build                                           # 五包构建过
```

- 一页一个 PR（或一组一个 PR），标题 `feat(web): <页面名> 按 v3.0 实现`。
- PR 正文必带 `Blocked by:` 与 `Blocks:` 两行（CI `fields` 检查），并附**改前 / 改后截图**（亮暗双模至少各一张）。
- 改文案的，同步改测试里的断言字符串；**不许为了让测试过而删断言或放宽 `toBe`**。
- 页面新增的交互只要不是「纯视觉」，就必须留下一个测试断言（要么 vitest，要么在 PR 里说明为什么测不到）。

## 七、禁止清单（踩了要回滚）

- 碰后端冻结清单（CI 会红，且不接受「我只是顺手改一行」）。
- 新增页面、改路由 path、把分栏拆成独立页。
- 引入新依赖 / 新 UI 库 / 图标库 / CSS-in-JS。
- 在页面里硬编码公司 id、员工 id、`preset_key`。
- 用稿子里的自造 cap 名（`purchase_order.*`、`apikey.*`、`reversal.*`）。
- 把 mock 数据、`console.log`、调试用的假按钮留在提交里。
- 改公共组件的默认行为而不检查所有调用方（`components/**` 被 20+ 页面引用）。
- 为配合代码去改 `design/v3.0/**`。

## 八、分批顺序（按这个来，别跳）

**第 0 步（前置，单独一个 PR）——✅ 已完成**：v3.0 样式在 `apps/web/src/styles/app-v30.css`（586 行，`index.css` 已 `@import`），图标在 `apps/web/src/components/icons/Icon.tsx`（**23 枚**，`<Icon name="pg-next" />`），由 #443 / PR #446 于 2026-11-24 合入（`98e351d`）。各批直接引用，不要再各写一套。

1. **单据 5 页 + 冲正页**（`/purchase-orders`、`/processing-orders`、`/sales-orders`、`/internal-trades`、`/settlements`、`/reversals`）—— #431
2. **主数据 4 页 + 员工页**（`/products` `/customers` `/suppliers` `/processors`、`/employees`）—— #432
3. **库存 3 页**（`/inventory`、`/inventory-flows`、`/stocktakes`）—— #433
4. **设置组 6 页**（`/permissions`、`/companies`、`/api-integration`、`/flow`、`/profit-report`、`/audit-logs`）—— #434
5. **登录 / 工作台**（`/login`、`/workbench`）—— #435，最后做，收前面所有组件的成果
