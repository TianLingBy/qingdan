# 前端改造规范边界（2026-11-21）

> 负责人裁定（2026-11-21 13:15）：**后端完全冻结**，前端不再等新后端能力、也不再重排 IA；
> 由前端（何永上 / `Meow-Yay`）**在现有页面基础上**逐页套上 v0.13 设计语言。
> 这份文件是派活与验收的唯一口径，issue 里只引用它，不重复抄。

## 一、你改什么、不改什么

| 路径 | 权限 | 说明 |
| --- | --- | --- |
| `apps/web/src/pages/**` | **可以改** | 本次的主体：页面结构、状态、文案、样式 |
| `apps/web/src/components/**` | **可以改** | 公共组件、页面内子组件 |
| `apps/web/src/styles/**`、Tailwind 配置 | **可以改** | v0.13 令牌与组件类 |
| `apps/web/src/lib/**`（除 `api.ts` 的接口签名） | 可以改 | 纯前端工具 |
| `apps/web/**/*.test.tsx` | **必须改** | 改页面就要让测试跟着绿，不许删断言 |
| `apps/api/**`、`packages/contracts/**`、`apps/api/migrations/**`、`docs/api/openapi.yaml`、`apps/cli/**`、`apps/mcp/**` | **不许碰** | 后端已完全冻结，CI `backend-frozen` 会直接红（见 `docs/BACKEND-FROZEN.md` 第七节） |
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

## 三、样式规则（怎么算「套上了 v0.13」）

1. **只用 v0.13 的令牌与组件类**：`apps/web/src/styles/tokens-v013.css` + `apps/web/src/styles/app-v013.css`，用法见 `apps/web/src/styles/README.md`。不许行内 `style=`、不许新造 CSS 变量、不许新引 UI 依赖。
2. 一页改完，页面上不该再出现零散的 Tailwind 拼装骨架（`grid gap-4 rounded border p-3` 这类）；换成 CSS 里的 `card` / `btn` / `chip` / `crumb` / `table` 家族。
3. 参考基线：单据四页（`pages/purchase/PurchaseOrdersPage.tsx`、`pages/processing/ProcessingOrdersPage.tsx`、`pages/sales/SalesOrdersPage.tsx`、`pages/internal-trades/InternalTradeOrdersPage.tsx`）已经把 v0.13 用起来，新页面照它们的写法。

## 四、四态与权限态（硬性）

1. **四态必须由 `data-state` 表达**，交给 CSS 渲染：`loading` / `empty` / `error` / `ok`。现有封装见 `apps/web/src/lib/list-state.ts`，**不许改成 JS 条件渲染**（`app-v013.css` 的 584 行全依赖这个属性）。
2. **权限三态**用 `allows(scope, domain, action)` 判定（`apps/web/src/lib/access.ts`），且：
   - 有权限：正常可点；
   - 无权限：按钮 `disabled` + `title="需要 <domain>.<action> 权限"`（文案格式照 `pages/masterdata/MasterdataPage.tsx:500-505` 的 `denyText(action)`）；
   - 不该看的：整块不渲染。
3. **绝不按职位判权**（不写 `role === 'finance'`、`isManager`、`isAdmin`）。只有 scope。
4. **没看价权限时后端根本不返回 `totalAmount` 键**，界面必须显示占位「—」，不许用 `0` 顶替。

## 五、能调什么接口

1. 只用 `docs/api/feature-matrix.md` 里已列出的 152 个端点（含每个端点的权限动作）。**不许新增后端接口、不许改契约**。
2. 该文件末尾「后端没有、不许画」的清单是硬边界：销售单审批、任何物理删除、批量操作、附件上传、打印 PDF、除 `profit_report` / `commission` 外的统计图表——**画出来就是假功能**。
3. 列表/导出的 `?scope=mine|all` 已由后端实现，前端只接线；没有 `read_all` 权限时不显示「看谁的」开关。
4. 那 22 个「后端就绪、前端没接」的端点**不在本次范围**（另见 #425），本次只做现有页面视觉与状态，不顺手接新接口。

## 六、验收口径（每页合并前必须过）

```powershell
pnpm -C apps/web exec tsc --noEmit                      # 类型干净
pnpm -C apps/web exec vitest run <本页测试文件>          # 至少本页测试绿
pnpm -r build                                           # 五包构建过
```

- 一页一个 PR（或一组一个 PR），标题 `feat(web): <页面名> 套 v0.13`。
- PR 正文必带 `Blocked by:` 与 `Blocks:` 两行（CI `fields` 检查），并附**改前 / 改后截图**。
- 改文案的，同步改测试里的断言字符串；**不许为了让测试过而删断言或放宽 `toBe`**。
- 页面新增的交互只要不是「纯视觉」，就必须留下一个测试断言（要么 vitest，要么在 PR 里说明为什么测不到）。

## 七、禁止清单（踩了要回滚）

- 碰后端冻结清单（CI 会红，且不接受「我只是顺手改一行」）。
- 新增页面、改路由 path、把分栏拆成独立页。
- 引入新依赖 / 新 UI 库 / 图标库。
- 在页面里硬编码公司 id、员工 id、`preset_key`。
- 把 mock 数据、`console.log`、调试用的假按钮留在提交里。
- 改公共组件的默认行为而不检查所有调用方（`components/**` 被 20+ 页面引用）。

## 八、分批顺序（按这个来，别跳）

1. **单据 5 页 + 冲正页**（`/purchase-orders`、`/processing-orders`、`/sales-orders`、`/internal-trades`、`/settlements`、`/reversals`）——已有 v0.13 基础，最出效果。
2. **主数据 4 页 + 员工页**（`/products` `/customers` `/suppliers` `/processors`、`/employees`）。
3. **库存 3 页**（`/inventory`、`/inventory-flows`、`/stocktakes`）。
4. **设置组 6 页**（`/permissions`、`/companies`、`/api-integration`、`/flow`、`/profit-report`、`/audit-logs`）。
5. **登录 / 工作台**（`/login`、`/workbench`）——最后做，它要收前面所有组件的成果。
