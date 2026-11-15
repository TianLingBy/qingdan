# 轻单 · 完整逻辑权限报告单（2026-11-15）

> 用途：前端照此写页面；主线照此排期。
> 合成来源：`C:\Users\32800\wsl-setup\matrix\m1.md`（主数据）、`m2.md`（A 采购 + 入库）、`m3.md`（B 加工）、`m4.md`（E 销售 + 收款 + 在线支付）、`m5.md`（N 内部交易 + 盘点 + R 客户退货 + S 供应商退货）、`m6.md`（C 结算 + 提成 + 利润报表 + 操作日志 + API 集成 + 订阅计费）。
> 禁止编造：本报告所有数字、端点、权限点、行号都能在 6 份素材中定位到出处；素材互相冲突处按「工作区现状」取值并显式标注（见 1.2 与第 7 节）。

**路径前缀约定**（与素材一致，全文通用）：

- `contracts/` = `packages/contracts/src/`
- `api/` = `apps/api/src/`
- `web/` = `apps/web/src/`
- `migrations/` = `apps/api/migrations/`
- `design/` = `design/v0.11/`

---

## 1. 一页速览

| 域 | 单据或实体 | 状态机取值 | 关键动作及其权限点 | 端点数 | 缺口数 |
|---|---|---|---|---|---|
| 主数据 | 商品 / 客户 / 供应商 / 加工厂 / 加工报价 / 员工 / 公司 / 岗位 | 商品·客户·供应商·加工厂：`启用 ⇄ 停用`（可写字段，非受控状态机）；加工报价：无状态；员工：`在职 → 停用` 单向；公司：无状态字段；岗位：`启用 → 停用` 单向 | 查 `*.read`；建 `*.create`；编 `*.update`（带 If-Match）；删/停用 `*.delete`（AI forbid + 必填原因）；看价 `product.view_price`；岗位与授权 `permission.read/create/update/delete` | 34 | 13 |
| A 采购 + 入库 | 采购单 / 库存批次 / 库存流水 | 采购单 `进行中 → 已完成`、`进行中 → 已取消`（三态，无草稿、无已入库） | 查 `purchase.read`；建 `purchase.create`；编 `purchase.update`；**完成（=同时入库）契约写 `purchase.approve`、后端实际判 `purchase.update`**；取消 `purchase.delete`；批次/流水只读 `inventory_qty.read`、`inventory_flow.read` | 9 | 9 |
| B 加工 | 加工单 | `进行中 → 已完成`、`进行中 → 已取消`（三态，无草稿、无已发料、无待核对） | 查 `processing.read`；建 `processing.create`；编 `processing.update`；完成/验收 `processing.approve`；取消 `processing.delete`；打印 `processing.read`；**无 `ship`、无 `export`** | 7 | 8 |
| E 销售 + 收款 + 支付 | 销售单 / 销售收款单 / 在线支付单 | 销售单：`进行中 → 已完成`、`进行中 → 已取消`；收款单：无状态（只追加）；支付单：`status` 自由文本、实际只写 `已支付` | 查 `sales.read`；建 `sales.create`；编 `sales.update`；**完成（=出库）仍挂 `sales.update`，无 `ship`**；取消 `sales.delete`；收款写 `sales.update`；看价 `sales.view_price`；导出 `sales.export`；支付回调 `payment.create`（publicAccess） | 11 | 8 |
| N 内部交易 + 盘点 + R + S | 内部交易单 / 盘点单 / 客户退货单 / 供应商退货单 | 内部交易：`进行中 → 在途 → 已完成`、`在途 → 进行中`（撤销发货）、`进行中/在途 → 已取消`；盘点：`待审批 → 已批准`（`已驳回` 为死态）；R/S：`进行中 → 已完成` 单向 | 内部交易：编 `internal_trade.update`、**发货与撤销发货 `internal_trade.ship`**、到货 `internal_trade.update`、取消 `internal_trade.delete`；盘点：盘盈 `stocktake.create`、盘亏 `stocktake.delete`、审批 `stocktake.approve`；R 完成 `customer_return.approve`（工作区）/`create`（HEAD）；S 完成 `supplier_return.approve`（工作区）/`create`（HEAD） | 21 | 12 |
| C 结算 + 提成 + 报表 + 日志 + API + 订阅 | 结算单 / 提成比例 / 利润报表 / 操作日志 / API Token / 订阅 | 结算单：`待确认 → 已结算`（两态，反向被 DB CHECK 结构性禁止）；提成比例：无状态（删旧建新）；报表/日志/Token/订阅：见 3.6 | 读 `settlement.read`、确认 `settlement.approve`、看价 `settlement.view_price`；提成 `commission.read/create/delete`；报表 `profit_report.read/view_price`；日志 `audit.read`（敏感读自记）；Token `api_integration.read/create/delete`；订阅 `billing.read/update` | 16 | 12 |
| **合计** | — | — | — | **98** | **62** |

缺口分档：**P0 15 条 / P1 32 条 / P2 15 条**（明细见第 4 节）。

### 1.2 素材之间的口径冲突（冲突一律以「工作区现状」为准）

| # | 冲突点 | 一方口径 | 另一方口径 | 本报告取值 |
|---|---|---|---|---|
| C1 | R 单 / S 单「完成」的权限点 | HEAD `1449111`：`action: 'create'`（`contracts/customer-returns.ts:181`、`contracts/supplier-returns.ts:120`），用例 `requireScope(...,'create')` | 工作区未提交改动：`action: 'approve'`，用例改 `requireScope(...,'approve')`（`api/modules/sales/usecases/customer-returns.ts:348`、`api/modules/purchase/usecases/supplier-returns.ts:280`） | **取 `approve`**；HEAD 口径作为回归对象记录（G03） |
| C2 | R/S 前端「完成」按钮控制位 | HEAD：`ReversalsPage.tsx` 无 `canApprove` prop，两个完成按钮用 `canCreate` | 工作区：`canApprove` 已传入（`web/pages/reversals/ReversalsPage.tsx:141-144`、`:150-153`），面板 `disabled={!canApprove…}`（`CustomerReturnsPanel.tsx:718-732`、`SupplierReturnsPanel.tsx:610-624`） | **取工作区（`canApprove`）** |
| C3 | 内部交易「到货确认」是否生成 C 结算草稿 | `api/modules/settlement/services/drafts.ts:34-36` 注释：N 单完成态尚未接线 | `api/modules/internal-trade/usecases/internal-trade-orders.ts:727-740`：receive 同事务 `settlementDraftPort().createDraft(… sourceDocType:'N' …)`；`contracts/internal-trade-orders.ts:31` 注释仍写「不做自动生成 C 单草稿（D29）」 | **取代码行为（已接线）**；两份注释按过期处理（G30） |
| C4 | 盘点「审批后自动生成 I 单冲正」 | `design/盘点.html:103` 脚注 | `api/modules/inventory/usecases/stocktakes.ts:434-442` 只写 `inventory_flow`（`source_doc_type='stocktake'`），全仓无派生 I 单的写入路径 | **取代码（不生成 I 单）**；设计文案作废（G34） |
| C5 | 采购单「完成」是否动库存 | `contracts/purchase-orders.ts:24-25`、`api/modules/purchase/repo.ts:388-393`、`web/pages/purchase/purchase-api.ts:11`、`web/pages/purchase/PurchaseOrdersPage.tsx:9` 均写「入库未接入、点了不动库存」 | `api/modules/purchase/usecases/purchase-orders.ts:445-454` + `api/modules/inventory/services/stock-flow.ts:313-349` 已建批次 + 写流水，测试 `purchase-orders-complete.test.ts:164-208` 钉死 | **取代码（已入库）**；四处注释作废（G44） |

---

## 2. 权限模型（写页面的人先看这段）

### 2.1 权限 = domain × action

- 唯一真源：`contracts/domains.ts`。scope 形如 `purchase.update`、`internal_trade.ship`。
- 8 个动作，全模块通用：`read` 查 / `create` 建 / `update` 编 / `approve` 审 / `ship` 出 / `delete` 删 / `view_price` 看价 / `export` 导。
- **没有「职位」。** 老板 / 财务 / 仓管 / 开发者在系统里只是「权限设置页的默认预设」，本质是一组被授予的 scope，可被单点撤销。代码里出现 `role === 'owner'`、`isManager`、`isAdmin`、`preset_key IN (...)` 都是缺陷（现存一例：G05）。
- **一个动作只对应一件事。** 发货/出库一律 `ship`；把发货挂到 `update` 上等于「能改单的人就能出货」（现存两例：G06 销售、G18 加工发料缺失后被迫寄生在 complete）。
- **前端判断只用 `allows(scope, domain, action)`。** 现网写法参考 `web/pages/purchase/PurchaseOrdersPage.tsx:666`：`const can = (action: ScopeAction) => allows(meData?.scope, 'purchase', action);`。
- **看价是独立的第 8 个动作，不是 read 的子集。** 无 `*.view_price` 时金额字段必须为 `null`（服务端）并显示 `—` 或 `MASKED_AMOUNT`（前端），且**不许在没有值的情况下提交金额**（现网做法：`web/pages/masterdata/MasterdataPage.tsx:516-530` 按 `canViewPrice` 决定带不带 `defaultSalesPrice`）。
- **AI 调用与人类调用分治。** 危险动作统一 `ai: { policy: 'forbid', reasonRequired: true }`，服务端另配 `assertHumanCredential`；`ai policy` 未声明的走 `defineRoute` 默认 `policy: 'allow'` / `reasonRequired: false`（`contracts/registry.ts:62`）。
- **并发一律 If-Match。** `requiresIfMatch: true` 的端点缺 `If-Match` 回 428 `PRECONDITION_REQUIRED`，版本不符回 409 `VERSION_CONFLICT`，前端必须重新读再重试，不许自动重提。

### 2.2 全部 domain 清单（素材内可确证 23 个）

| # | domain | 中文名 | 已用动作 | 本报告出处 |
|---|---|---|---|---|
| 1 | `product` | 商品 | read / create / update / delete / view_price | m1 |
| 2 | `customer` | 客户 | read / create / update / delete | m1 |
| 3 | `supplier` | 供应商 | read / create / update / delete | m1 |
| 4 | `processor` | 加工厂 + 加工报价 | read / create / update / delete | m1 |
| 5 | `employee` | 员工 | read / create / update / delete | m1 |
| 6 | `company` | 公司 | read / create / update | m1 |
| 7 | `permission` | 岗位与授权 | read / create / update / delete | m1 |
| 8 | `purchase` | A 采购单 | read / create / update / delete / approve(契约) | m2 |
| 9 | `inventory_qty` | 库存批次 | read | m2 |
| 10 | `inventory_flow` | 库存流水 | read | m2 |
| 11 | `processing` | B 加工单 | read / create / update / approve / delete | m3 |
| 12 | `sales` | E 销售单 + 收款 | read / create / update / delete / approve(未落地) / view_price / export | m4 |
| 13 | `payment` | 在线支付 | create（回调） | m4 |
| 14 | `internal_trade` | N 内部交易 | read / create / update / delete / ship | m5 |
| 15 | `stocktake` | 盘点 | read / create / delete / approve | m5 |
| 16 | `customer_return` | R 客户退货 | read / create / approve | m5 |
| 17 | `supplier_return` | S 供应商退货 | read / create / approve | m5 |
| 18 | `settlement` | C 结算单 | read / approve / view_price | m6 |
| 19 | `commission` | 提成比例 | read / create / delete | m6 |
| 20 | `profit_report` | 利润报表 | read / view_price | m6 |
| 21 | `audit` | 操作日志 | read | m6 |
| 22 | `api_integration` | API 与集成 | read / create / delete | m6 |
| 23 | `billing` | 订阅计费 | read / update | m6 |

> **待核**：项目根 `AGENTS.md` 记 `contracts/domains.ts` 共 **24** 个 domain（24 × 8 = 192 个权限点），本报告只能从 6 份素材里确证 23 个且未找到第 24 个的出处；`web/lib/access.ts:38` 出现的 `stocktake_page` 是页面 id，不是 domain。第 24 个 domain 的名字必须以 `contracts/domains.ts` 全表为准，不得由本报告推测（核对项见 4.4）。

### 2.3 前端三态判定模板

```ts
const can = (action: ScopeAction) => allows(me?.scope, DOMAIN, action);

// 有权限 + 状态允许 → 可点
// 有权限 + 状态不允许 → 禁用，tooltip 写「当前状态：进行中才可完成」
// 无权限 → 禁用 + 明写缺哪个权限点（不是笼统「无权操作」）
const reason = !can(action) ? `缺少 ${DOMAIN}.${action} 权限`
             : !stateAllowed ? `当前状态（${status}）不允许该操作`
             : null;
```

现网已有的正确样例：`web/pages/purchase/PurchaseOrdersPage.tsx:649-654`（`当前身份无取消权限（purchase.delete）` / `当前身份无完成权限（purchase.approve）`）。

---

## 3. 逐域详表

> 每节固定四张表：① 状态机与允许的动作；② 端点清单；③ 前端落点；④ 设计稿对照。
> `requiresIfMatch` 未显式声明为 false（`contracts/registry.ts:65`）；`ai` 未显式声明按默认 `allow`。

### 3.1 主数据（商品 / 客户 / 供应商 / 加工厂 / 加工报价 / 员工 / 公司 / 岗位）

#### ① 状态机与允许的动作

| 实体 | 取值 | 允许流转 | 落点 | 备注（口径） |
|---|---|---|---|---|
| 商品 | `启用` / `停用` | 新建→`启用`（缺省）；`启用 ⇄ 停用`（`status` 在更新白名单里） | `api/modules/masterdata/repo.ts:204-228`、`:80-91` | 状态是**可写字段**，不是受控状态机 |
| 客户 | `启用` / `停用` | 同上 | `contracts/customers.ts:59`、`api/modules/masterdata/repo-customers.ts:79-89` | 同上 |
| 供应商 | `启用` / `停用` | 同上 | `contracts/suppliers.ts:61` | 同上 |
| 加工厂 | `启用` / `停用` | 同上 | `contracts/processors.ts:102` | 同上 |
| 加工报价 | 无状态字段 | 只增不改（无 update / delete 路由） | `contracts/processors.ts:56-74`、`:214-240` | 契约注释明写「只增不改」`contracts/processors.ts:146-147` |
| 员工 | `在职` / `停用` | `在职 → 停用` 单向，无复活端点 | `api/modules/platform/usecases/employees.ts:800-806` | 停用幂等短路 `:781-785`；最后一个在职老板不可停 `:787-798` |
| 公司 | 无状态字段 | 无 | `contracts/companies.ts:21-31`、`:41-55` | 只有 name 可改 `api/modules/platform/usecases/companies.ts:295-349` |
| 岗位 | `启用` / `停用` | 新建→`启用`；`启用 → 停用` 单向 | `api/modules/platform/usecases/positions.ts:311-322`、`:477-483` | 被员工占用即 409 `STATE_CONFLICT`/`POSITION_IN_USE` `:464-474` |

软删除无状态守卫（四处同构）：`api/modules/masterdata/repo.ts:299-309`、`repo-customers.ts:291-300`、`repo-suppliers.ts:291-300`、`repo-processors.ts:355-364` —— WHERE 里没有 `AND status = '启用'`，已停用记录再删一次仍 `version+1`。

#### ② 端点清单（34 条）

| operationId | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| `product.list.read` | GET `/api/v1/products` | product.read | false | allow（默认，audit none） |
| `product.create` | POST `/api/v1/products` | product.create | false | allow（audit write，201） |
| `product.detail.read` | GET `/api/v1/products/{id}` | product.read | false | allow（默认） |
| `product.update` | PATCH `/api/v1/products/{id}` | product.update | **true** | allow（audit write） |
| `product.delete` | DELETE `/api/v1/products/{id}` | product.delete | **true** | **forbid + reasonRequired** |
| `customer.list.read` | GET `/api/v1/customers` | customer.read | false | allow |
| `customer.create` | POST `/api/v1/customers` | customer.create | false | allow |
| `customer.detail.read` | GET `/api/v1/customers/{id}` | customer.read | false | allow |
| `customer.update` | PATCH `/api/v1/customers/{id}` | customer.update | **true** | allow |
| `customer.delete` | DELETE `/api/v1/customers/{id}` | customer.delete | **true** | **forbid + reasonRequired** |
| `supplier.list.read` | GET `/api/v1/suppliers` | supplier.read | false | allow |
| `supplier.create` | POST `/api/v1/suppliers` | supplier.create | false | allow |
| `supplier.detail.read` | GET `/api/v1/suppliers/{id}` | supplier.read | false | allow |
| `supplier.update` | PATCH `/api/v1/suppliers/{id}` | supplier.update | **true** | allow |
| `supplier.delete` | DELETE `/api/v1/suppliers/{id}` | supplier.delete | **true** | **forbid + reasonRequired** |
| `processor.list.read` | GET `/api/v1/processors` | processor.read | false | allow |
| `processor.create` | POST `/api/v1/processors` | processor.create | false | allow |
| `processor.detail.read` | GET `/api/v1/processors/{id}` | processor.read | false | allow |
| `processor.update` | PATCH `/api/v1/processors/{id}` | processor.update | **true** | allow |
| `processor.delete` | DELETE `/api/v1/processors/{id}` | processor.delete | **true** | **forbid + reasonRequired** |
| `processor.quote.read` | GET `/api/v1/processor-quotes` | processor.read | false | allow（audit none） |
| `processor.quote.create` | POST `/api/v1/processor-quotes` | processor.create | false | allow（audit write，201） |
| `platform.employee.read` | GET `/api/v1/employees` | employee.read | false | 未显式声明（audit none） |
| `platform.employee.create` | POST `/api/v1/employees` | employee.create | false | **forbid**（201） |
| `platform.employee.update` | PATCH `/api/v1/employees/{id}` | employee.update | **true** | allow |
| `platform.employee.disable` | DELETE `/api/v1/employees/{id}` | employee.delete | **true** | **forbid + reasonRequired** |
| `platform.company.list` | GET `/api/v1/companies` | company.read | false | allow（audit none） |
| `platform.company.create` | POST `/api/v1/companies` | company.create | false | **forbid**（201） |
| `platform.company.update` | PATCH `/api/v1/companies/{id}` | company.update | **true** | allow |
| `platform.position.list` | GET `/api/v1/positions` | permission.read | false | allow |
| `platform.position.create` | POST `/api/v1/positions` | permission.create | false | **forbid + reasonRequired** |
| `platform.position.update` | PATCH `/api/v1/positions/{id}` | permission.update | **true** | **forbid + reasonRequired** |
| `platform.position.delete` | DELETE `/api/v1/positions/{id}` | permission.delete | **true** | **forbid + reasonRequired** |
| `platform.permission.update` | PATCH `/api/v1/employees/{employeeId}/permissions` | permission.update | false（选填；缺省跳过版本校验并审计 `versionChecked=false`） | **forbid + reasonRequired**，支持 dryRun |

出处：`contracts/products.ts:96-160`、`contracts/customers.ts:89-153`、`contracts/suppliers.ts:97-158`、`contracts/processors.ts:152-240`、`contracts/routes.ts:163-173`、`contracts/employees.ts:69-107`、`contracts/companies.ts:67-103`、`contracts/positions.ts:126-178`、`contracts/routes.ts:225-239`。
挂载：`api/routes.ts:175/177/179`（employee/position/company）、`:241/243/245/247`（product/customer/supplier/processor）。

#### ③ 前端落点

| 控件 / 字段 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| 主数据「+ 新增」 | `web/pages/masterdata/MasterdataPage.tsx:626-632` | `product.create` 或 `customer.create` / `supplier.create` / `processor.create` | **无判定**，无条件渲染，靠服务端 403 |
| 主数据行内「编辑」 | `web/pages/masterdata/MasterdataPage.tsx:741-747` | `*.update` | **无判定** |
| 主数据行内「停用」 | `web/pages/masterdata/MasterdataPage.tsx:748-755` | `*.delete` | **无判定**；仅 `disabled={item.status === '停用' || disable.isPending}` |
| 加工厂行内「报价」 | `web/pages/masterdata/MasterdataPage.tsx:733-739` | `processor.read` | **无判定** |
| 报价面板提交 | `web/pages/masterdata/MasterdataPage.tsx:337-448`（按钮 `:399-405`） | `processor.create` | **无判定** |
| 默认售价输入框 | `web/pages/masterdata/MasterdataPage.tsx:233-243` | `product.view_price` | 唯一有判定的地方：`me.data?.scope.some(e => e.domain === 'product' && e.actions.includes('view_price'))`（`:464-467`）；无权限时 `disabled` + `placeholder="无看价权限"`，提交时按 `canViewPrice` 决定带不带该字段（`:516-530`） |
| 员工页唯一按钮「权限」 | `web/pages/employees/EmployeesPage.tsx:148-156` | `permission.update` | 只判 `canOpenPanel = meQuery.data !== undefined`（`:52`），无 scope 判定 |
| 员工页关键字搜索 | `web/pages/employees/EmployeesPage.tsx:41-50` | — | 纯前端本地过滤（姓名 / 工号 / `phoneMasked`），不发服务端 `keyword` |
| 权限面板勾选范围 | `web/pages/employees/PermissionOverridePanel.tsx:76-80` | `permission.update` | 勾选范围 = 当前登录人自己的 scope，老板用 `hasFullScope` 判（`:52`） |
| 公司「创建」/「改名」 | `web/pages/companies/CompaniesPage.tsx:74-81`、`:156-184` | `company.create` / `company.update` | **无 scope 判定**；只按 428/409/403 分流文案（`:201-209`） |
| 权限页「新建岗位」/「编辑模板」/「停用」 | `web/pages/permissions/PermissionsPage.tsx:148-154`、`:242-248`、`:249-259` | `permission.create` / `permission.update` / `permission.delete` | **全线无 scope 显隐**，仅 403 文案分流（`:446`） |

#### ④ 设计稿对照

**设计有、代码没有**

| 设计稿 | 代码现状 |
|---|---|
| 公司管理：状态筛选「全部状态 / 启用 / 停用」+ 页脚「停用公司后，该公司的员工不能登录」（`design/公司管理.html`） | 契约无 `status` 字段（`contracts/companies.ts:21-31`、`:41-55`），无停用/删除端点（`contracts/companies.ts:67-103`）；`CompaniesPage` 无筛选与停用按钮（`web/pages/companies/CompaniesPage.tsx:129-184`） |
| 公司码 `HQ` / `HD` / `HN`（2 位字母） | 契约 `^[0-9]{4}$`（`contracts/companies.ts:17-19`），服务端 `padStart(4,'0')`（`api/modules/platform/usecases/companies.ts:192`） |
| 员工：「+ 新建员工」、行内「编辑」、状态筛选（`design/员工.html`） | `EmployeesPage` 只有列表 + 「权限」按钮（`web/pages/employees/EmployeesPage.tsx:148-156`） |
| 加工厂列表列含「工序」「单价」（`design/加工厂档案.html`） | 列表只有 编号/名称/补充信息/状态（`web/pages/masterdata/MasterdataPage.tsx:700-707`），工序价移到报价面板 `:337-448` |
| 权限设置矩阵列头 4 个动作（查看/新建/审批/导出） | 代码 7 个动作（`TEMPLATE_ACTION_KEYS` = 8 动作去掉 `view_price`，`contracts/positions.ts:47`） |
| 权限设置「全部岗位」预设筛选下拉 | 前端无筛选控件；后端 `PositionListQuerySchema` 已支持 `presetKey`（`contracts/positions.ts:88-90`） |
| 商品列「规格」独立一列；客户/供应商列「电话」独立一列 | 代码合并进「补充信息」= `规格 · 别名 · 单位`（`web/pages/masterdata/MasterdataPage.tsx:92-95`）、`:96-103` |

**代码有、设计没画**

| 代码能力 | 证据 |
|---|---|
| 默认售价按 `product.view_price` 掩码/置灰，列表返回 `defaultSalePrice = null` | `api/modules/masterdata/usecases/products.ts:88-94`；`web/pages/masterdata/MasterdataPage.tsx:233-243` |
| 加工厂报价录入（日期/工序/单价/备注）+ 只增不改 + 比价排序（同工序按单价升序、复合游标） | `web/pages/masterdata/MasterdataPage.tsx:370-412`；`api/modules/masterdata/repo-processors.ts:467-488`、`:417-441` |
| 员工个人权限覆盖面板（dryRun 预演 + 保存 + 越权边界拦截） | `web/pages/employees/PermissionOverridePanel.tsx:280-290`；`api/modules/platform/usecases/permission-overrides.ts:576-578`、`:594-601` |
| 权限覆盖的 If-Match 可选（缺省跳过版本校验并记 `versionChecked=false`） | `contracts/routes.ts:225-239`；`api/modules/platform/usecases/permission-overrides.ts:571-574` |
| 主数据「全部状态」筛选 + 游标分页 | `web/pages/masterdata/MasterdataPage.tsx:635-651`、`:766-786` |
| 岗位停用被占用时 409 `POSITION_IN_USE` + 前端提示先改绑 | `api/modules/platform/usecases/positions.ts:464-474`；`web/pages/permissions/PermissionsPage.tsx:120` |
| 岗位「类型」列区分「预设 · xx」/「自定义」 | `web/pages/permissions/PermissionsPage.tsx:216-220` |
| 员工「最后一个在职老板不可停用」 | `api/modules/platform/usecases/employees.ts:787-798` |

### 3.2 A 采购 + 入库（采购单 / 库存批次 / 库存流水）

#### ① 状态机与允许的动作

| 状态 | 允许的动作 | 端点 | 落点 | 备注 |
|---|---|---|---|---|
| `进行中` | 查 / 编 / 取消 / 完成（=入库） | `purchase.order.update` / `.cancel` / `.complete` | `api/modules/purchase/repo.ts:620-630`、`:682-693`、`:705-707` | 编辑与两项流转 SQL 全带 `AND status = '进行中'` |
| `已完成` | 只读 | — | `api/modules/purchase/repo.ts:705-707` | 无反向流转（无端点、无 SQL） |
| `已取消` | 只读 | — | `api/modules/purchase/repo.ts:682-693` | 取消前置：`assertCancelable`（`contracts/documents.ts:29-33`）+ 下游检查 |
| `（新建）` | 建 | `purchase.order.create` | `api/modules/purchase/repo.ts:564-568` | 直接落 `进行中`，无草稿态 |

- 枚举唯一真源：`HEADER_STATES = ['进行中','已完成','已取消']`（`contracts/documents.ts:7`），采购单侧 `z.enum(HEADER_STATES)`（`contracts/purchase-orders.ts:42`）；DB CHECK 同口径 `migrations/0010_purchase_orders.sql:39-40`。
- 取消判定三值：`already_completed` / `already_cancelled` / `has_downstream`（`contracts/documents.ts:22-27`）。下游只看库存流水：`api/modules/purchase/repo.ts:394-410`（`source_doc_type IN ('A','purchase_order')`）⇒ **完成入库后再取消会被 `has_downstream` 拦住**。
- 库存四个量字段（`migrations/0008_inventory_core.sql:39-42`、`:45-49`、`:57`）：

```sql
remaining_qty amount GENERATED ALWAYS AS (inbound_qty - referenced_qty) STORED,
available_qty amount GENERATED ALWAYS AS (
    inbound_qty - referenced_qty - in_transit_qty - pending_execution_qty) STORED,
CONSTRAINT inventory_batch_available_qty_nonnegative CHECK (available_qty >= 0)
```

- 写这些字段的路径：`inbound_qty` ← 建批次（`api/modules/inventory/services/stock-flow.ts:313-329`）、盘点调整（`:424-435`）、加工扣料（`:424-435`）、销售出库（`:424-435`）、R 退货入库、S 退货出库；`in_transit_qty` ← N 单 `api/modules/internal-trade/repo.ts:788`、`:816`、`:848`、`:883` 与批次转司 `stock-flow.ts:96-112`；**`referenced_qty` / `pending_execution_qty` 在 `api/` 非测试代码里没有任何写入语句**（全仓 grep `SET referenced_qty`、`pending_execution_qty =` 零命中），当前恒为 0。

#### ② 端点清单（9 条）

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `purchase.order.list.read` | GET `/api/v1/purchase-orders` | purchase.read | false | 未设置（audit none） | `contracts/purchase-orders.ts:228-239` |
| `purchase.order.create` | POST `/api/v1/purchase-orders` | purchase.create | false | forbid（audit write，201） | `contracts/purchase-orders.ts:240-252` |
| `purchase.order.detail.read` | GET `/api/v1/purchase-orders/{id}` | purchase.read | false | 未设置（audit none） | `contracts/purchase-orders.ts:253-263` |
| `purchase.order.update` | PATCH `/api/v1/purchase-orders/{id}` | purchase.update | **true** | allow（audit write） | `contracts/purchase-orders.ts:264-277` |
| `purchase.order.cancel` | POST `/api/v1/purchase-orders/{id}/cancel` | purchase.delete | **true** | **forbid + reasonRequired**（audit write） | `contracts/purchase-orders.ts:278-290` |
| `purchase.order.complete` | POST `/api/v1/purchase-orders/{id}/complete` | **purchase.approve**（契约）/ 后端实判 `purchase.update` | **true** | **forbid + reasonRequired**（audit write） | `contracts/purchase-orders.ts:221-227` |
| `inventory.batch.list.read` | GET `/api/v1/inventory/batches` | inventory_qty.read | false | 未设置（audit none） | `contracts/inventory.ts:150-186` |
| `inventory.batch.detail.read` | GET `/api/v1/inventory/batches/{id}` | inventory_qty.read | false | 未设置（audit none） | `contracts/inventory.ts:150-186` |
| `inventory.flow.read` | GET `/api/v1/inventory/flows` | inventory_flow.read | false | 未设置（audit none） | `contracts/inventory.ts:150-186` |

- 库存模块**没有任何 HTTP 写端点**（契约明文 `contracts/inventory.ts:8-10`、`:148`）。
- 「完成」的真实写集合：`purchase_order.status` + 每行 1 条 `inventory_batch` + 每行 1 条正 `delta` 的 `inventory_flow`（`source_doc_type='A'`、`handled_by=principal.employeeId`、`custodian_id=order.handlerId`、`locked_unit_cost=line.unitPrice`），同一事务同一审计（`api/modules/purchase/usecases/purchase-orders.ts:437-457`）。测试钉死：`api/modules/purchase/usecases/purchase-orders-complete.test.ts:164-208`。
- 完成前硬前置：`line.unitPrice === null`（无看价）直接 `VALIDATION_FAILED('完成采购单需要看价权限')`（`api/modules/purchase/usecases/purchase-orders.ts:446`）。

#### ③ 前端落点

| 控件 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| 详情「完成采购单」 | `web/pages/purchase/PurchaseOrdersPage.tsx:632-639`（`canComplete` 传入 `:1205`） | `purchase.approve`（前端口径） | `disabled={order.status !== '进行中' \|\| !canComplete \|\| completing}`；无权限提示「当前身份无完成权限（purchase.approve）」`:652-654` ⇒ **只被授予 `update` 的人按钮灰、接口却能过；只被授予 `approve` 的人按钮亮、接口 403** |
| 详情「编辑」 | `web/pages/purchase/PurchaseOrdersPage.tsx:624-631` | `purchase.update` | `disabled={order.status !== '进行中'}`，**不判 scope** |
| 详情「取消采购单」 | `web/pages/purchase/PurchaseOrdersPage.tsx:640-647` | `purchase.delete` | `disabled={!order.cancelable.allowed \|\| !canCancel \|\| canceling}`，提示 `:649-651` |
| 列表行「编辑」 | `web/pages/purchase/PurchaseOrdersPage.tsx:1137-1145` | `purchase.update` + `purchase.view_price` | `disabled={!can('update') \|\| !canViewPrice \|\| status !== '进行中'}` |
| 列表行「取消」 | `web/pages/purchase/PurchaseOrdersPage.tsx:1146-1153` | `purchase.delete` | `disabled={!can('delete') \|\| status !== '进行中' \|\| cancelOrder.isPending}` |
| 「+ 新建」 | `web/pages/purchase/PurchaseOrdersPage.tsx:953-960` | `purchase.create` | `disabled={!can('create') \|\| companyIds.length === 0}` |
| 完成后缓存刷新 | `web/pages/purchase/PurchaseOrdersPage.tsx:831-836` | — | **只 `invalidateQueries(['purchase-orders'])`**，不刷 `['inventory', ...]` ⇒ 刚入库的批次在库存页看不到 |
| 库存页 scope | `web/pages/inventory/InventoryPage.tsx:36-39` | `inventory_qty.read` / `.view_price` | `view_price / read / update / approve` 全挂 `inventory_qty` |
| 库存流水页 | `web/pages/inventory/InventoryFlowsPage.tsx:69`、`:188` | `inventory_flow.read` | 只读，无写入口 |
| 盘盈/盘亏/审批（复用面板） | `web/pages/inventory/StocktakesPage.tsx:31-33` | `stocktake.create` / `.delete` / `.approve` | 见 3.5 |

#### ④ 设计稿对照

**设计有、代码没有**

| 设计元素 | 证据 | 代码侧 |
|---|---|---|
| 单据详情「确认入库」（独立于「完成」的一步） | `design/单据详情.html:261`、`:266`、`:396-401` | 只有「完成采购单」一个动作，完成即同时建批次+流水（`api/modules/purchase/usecases/purchase-orders.ts:445-454`），无独立入库端点 |
| 「入库批次 B-2026-1088」回显 | `design/单据详情.html:282`、`:411` | `PurchaseOrder` 契约无 `batchIds`/`batchNo`（`contracts/purchase-orders.ts:122-147`） |
| 状态「已入库」「待供应商确认」「草稿」 | `design/采购单A.html:20-22`、`design/单据详情.html:464` | 枚举只有三态（`contracts/documents.ts:7`、`migrations/0010_purchase_orders.sql:39-40`） |
| 库存页「录入入库」抽屉 | `design/库存.html:30-41` | 无端点、无前端方法（`web/pages/inventory/inventory-api.ts:58-149`），契约明令不登记写端点（`contracts/inventory.ts:8-10`） |
| 库存页「仓库」列与筛选 | `design/库存.html:22`、`:26-27` | `inventory_batch` 建表无仓库字段（`migrations/0008_inventory_core.sql:27-58`） |
| 采购单列表「导出」、库存页「导出」 | `design/采购单A.html:16`、`design/库存.html:16` | 两个契约均无 export 端点（`contracts/purchase-orders.ts:220-291`、`contracts/inventory.ts:150-186`） |
| KPI 区（可售批次 / 在途量 / 锁定金额） | `design/库存.html:17-19` | 无汇总端点（`api/modules/inventory/routes.ts:34-133` 只有 list/detail/flows + 盘点/成本调整） |
| 库存流水来源分段（采购入库/销售出库/加工投入/加工产出/冲正/盘点） | `design/库存流水.html:98`、`:101` | 前端无该分段控件（`web/pages/inventory/InventoryFlowsPage.tsx` 全文无来源筛选） |

**代码有、设计没画**

| 代码能力 | 证据 | 设计侧 |
|---|---|---|
| 完成时逐行建批次、锁价 = 明细单价、**不摊运费与杂费（D5 未落地）** | `api/modules/purchase/usecases/purchase-orders.ts:447-451` | `design/单据详情.html:266` 只说「成本就会记到库存里」，无摊销说明 |
| 完成的真实权限点是 `purchase.update`（契约与前端都写 `approve`） | 后端 `api/modules/purchase/usecases/purchase-orders.ts:432`；契约 `contracts/purchase-orders.ts:223`；前端 `web/pages/purchase/PurchaseOrdersPage.tsx:1205` | 设计稿不体现权限点 |
| 批次成本更正界面（491 行） | `web/pages/inventory/BatchCostAdjustments.tsx:237-474` | v0.11 无对应页面 |
| 盘点独立路由 `/stocktakes` 与「冲正页里的盘点栏」双入口 | `web/pages/inventory/StocktakesPage.tsx:27-33`、`web/pages/reversals/ReversalsPage.tsx:157-164` | `design/盘点.html` 只有一页 |
| 无看价权限不允许完成 | `api/modules/purchase/usecases/purchase-orders.ts:446` | 设计稿无此约束 |
| `cancelable` 由服务端下发（含 `has_downstream`） | `contracts/purchase-orders.ts:154-158`、`api/modules/purchase/usecases/purchase-orders.ts:257` | `design/单据详情.html:420` 只写「还没入库的可以取消」，无下游拦截态 |

---

### 3.3 B 加工（加工单）

#### ① 状态机与允许的动作

| 从 | 到 | 触发端点 | 权限点 | 落点 |
|---|---|---|---|---|
| — | `进行中` | `POST /api/v1/processing-orders` | `processing.create` | `api/modules/processing/repo.ts:612-632` |
| `进行中` | `已完成` | `POST …/{id}/complete` | `processing.approve` | `api/modules/processing/usecases/processing-orders.ts:494-583` |
| `进行中` | `已取消` | `POST …/{id}/cancel` | `processing.delete` | `api/modules/processing/repo.ts:763-777` |
| `进行中` | `进行中`（编辑） | `PATCH …/{id}` | `processing.update` | `api/modules/processing/repo.ts:662-666`（`AND status='进行中'`） |

- 三态无第四态：`contracts/processing-orders.ts:49`；DB CHECK `migrations/0012_processing_orders.sql:39-40`。
- 取消前查下游：`api/modules/processing/repo.ts:375-391`（`source_doc_type IN ('B','processing_order')`）+ `assertCancelable`（`usecases/processing-orders.ts:464-467`）。
- **无审核中间态**：`approve` 动作只用于 complete 本身（`contracts/processing-orders.ts:395`），不是「先审后完成」。
- 完成时的成本与产出（D5 已落地）：
  - 材料成本 = `Σ(qty × 批次 locked_unit_cost)`（`usecases/processing-orders.ts:522-532`）；总成本 = 材料 + 费用合计（`:543-544`）；产出单价 = `totalCost × SCALE / sellable`（`:552`）→ 写 `inventory_batch.locked_unit_cost`（`api/modules/inventory/services/stock-flow.ts:315`），一次锁定、之后不重算。
  - `sellable === 0` 必须 `confirmFullLoss=true`（`:520`），全损耗不建产出批次（`contracts/processing-orders.ts:29-30`）。
  - 材料扣减同事务逐行 `applyAdjustment(delta = -qty, sourceDocType='B')`（`:533-541`）→ `UPDATE inventory_batch SET inbound_qty = inbound_qty + delta, version = version + 1`（`stock-flow.ts:424-435`）。
  - 产出批次 + 流水 `sourceDocType='B'`（`:560-562`；`stock-flow.ts:314-350`）；保管人 `input.custodianId ?? order.handlerId`（`:559`）。

#### ② 端点清单（7 条）

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `processing.order.list.read` | GET `/api/v1/processing-orders` | processing.read | false | 未声明（audit none） | `contracts/processing-orders.ts:325-336` |
| `processing.order.create` | POST `/api/v1/processing-orders` | processing.create | false | forbid（audit write，201） | `contracts/processing-orders.ts:337-350` |
| `processing.order.detail.read` | GET `/api/v1/processing-orders/{id}` | processing.read | false | 未声明（audit none） | `contracts/processing-orders.ts:351-361` |
| `processing.order.update` | PATCH `/api/v1/processing-orders/{id}` | processing.update | **true** | allow | `contracts/processing-orders.ts:362-375` |
| `processing.order.cancel` | POST `/api/v1/processing-orders/{id}/cancel` | processing.delete | **true** | forbid + reasonRequired | `contracts/processing-orders.ts:376-388` |
| `processing.order.complete` | POST `/api/v1/processing-orders/{id}/complete` | processing.approve | **true** | forbid | `contracts/processing-orders.ts:389-402` |
| `processing.order.print` | GET `/api/v1/processing-orders/{id}/print` | processing.read | false | 未声明（audit none） | `contracts/prints.ts:33-43` |

- **本模块没有 `ship` 端点，也没有 `export` 端点**（`contracts/processing-orders.ts:324-403` + `contracts/prints.ts:33-43`）。
- 三个写用例额外 `assertHumanCredential`（`api/modules/processing/usecases/processing-orders.ts:356`、`:447`、`:499`）。
- 端口只开两个写函数：`api/modules/inventory/services/ports.ts:15-42`（注释明写「不新增第二条库存写入路径」`:9-14`）。

#### ③ 前端落点

| 按钮 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| 「+ 新建」 | `web/pages/processing/ProcessingOrdersPage.tsx:1318-1325` | `processing.create` | `disabled={!can('create') \|\| companyIds.length === 0}` |
| 列表行「编辑」 | `web/pages/processing/ProcessingOrdersPage.tsx:1559-1567` | `processing.update` + `view_price` | `disabled={!can('update') \|\| !canViewPrice \|\| status !== '进行中'}` |
| 列表行「完成/验收」 | `web/pages/processing/ProcessingOrdersPage.tsx:1546-1558` | `processing.approve` | `disabled` 含 `!can('approve')`，title「需要 processing.approve」 |
| 列表行「取消」 | `web/pages/processing/ProcessingOrdersPage.tsx:1568-1575` | `processing.delete` | `disabled={!can('delete') \|\| …}` |
| 详情面板「完成/验收」 | `web/pages/processing/ProcessingOrdersPage.tsx:890-897`、`:922-926` | `processing.approve` | `disabled={status !== '进行中' \|\| !canComplete \|\| completing}` |
| 详情面板「编辑」 | `web/pages/processing/ProcessingOrdersPage.tsx:898-905` | `processing.update` | **只判 `status === '进行中'`，不判 `can('update')`** |
| 详情面板「取消」 | `web/pages/processing/ProcessingOrdersPage.tsx:906-913`、`:927-929` | `processing.delete` | `order.cancelable.allowed && canCancel`，提示 `:927-929` |
| 详情面板「打印发厂联」 | `web/pages/processing/ProcessingOrdersPage.tsx:914-920` | `processing.read` | **无 scope 判断** |
| 金额脱敏 | `web/pages/processing/ProcessingOrdersPage.tsx:833`、`:835`、`:859`、`:878` | `processing.view_price` | 前端遮罩成 `MASKED_AMOUNT`；页面自陈「processing 端点目前没有服务端金额脱敏（与采购单不同）」`:1334-1341` |
| 完成面板 | `web/pages/processing/ProcessingOrdersPage.tsx:608-713`（全损耗勾选 `:677-689`、按钮文案 `:700-706`） | `processing.approve` | 投入量只读 / 损耗量输入 / 可售量派生展示 |
| 材料批次下拉 | `web/pages/processing/processing-api.ts:86-94` | `inventory_qty.read` | 只读 `GET /inventory/batches`，**前端不能发料** |
| 状态筛选 | `web/pages/processing/ProcessingOrdersPage.tsx:1382-1386`、`STATUS_STYLE:59-63` | — | 三态 |

- 「验收」没有独立端点与 `accept` 动作：**验收 = complete**，只是按钮文案（`contracts/processing-orders.ts:389-402`）。

#### ④ 设计稿对照

**设计有、代码没有**

| 设计元素 | 代码现状 | 证据 |
|---|---|---|
| 「导出」按钮 | 无 export 端点、无前端按钮 | `contracts/processing-orders.ts:324-403`；`web/pages/processing/ProcessingOrdersPage.tsx:1318-1325`（工具栏只有新建） |
| 状态「草稿 / 加工中 / 待核对」 | 只有 进行中/已完成/已取消 | `contracts/processing-orders.ts:49`；`migrations/0012_processing_orders.sql:39-40` |
| 「加工厂回传成品与损耗」 | 无回传端点、无回传字段；损耗量由执行 complete 的人自己填 | `contracts/processing-orders.ts:324-403`；`api/modules/processing/usecases/processing-orders.ts:516-520` |
| 「核对入库」 | 无核对/入库确认端点，产出批次在 complete 事务内直接落库 | `api/modules/processing/usecases/processing-orders.ts:548-566` |
| 「损耗率超阈值的审批」 | 无 threshold 字段、无审批态、无端点；只有全损耗 `confirmFullLoss` 硬确认 | `contracts/processing-orders.ts:206-210`、`:389-402`；`design/业务全流程图.html:101` 自列「待补」 |
| 负责人列「仅老板/经理可见」 | 列表未做列级权限，只按 scope 判 | `web/pages/processing/ProcessingOrdersPage.tsx:940-941` |
| 列表「损耗率 / 可售量」 | 列表无此列，只在完成面板内派生显示 | `web/pages/processing/ProcessingOrdersPage.tsx:608-713`（详情面板）、`:1490-1609`（列表列） |

**代码有、设计没画**

| 代码能力 | 证据 | 说明 |
|---|---|---|
| 材料投入行（批次 + 数量，≥1 行且合计 = 投入量） | `contracts/processing-orders.ts:56-89` | 设计表只有一个「投入数量」数字 |
| 加工费多行明细 | `contracts/processing-orders.ts:103-113`；`api/modules/processing/repo.ts:551-597` | 设计只有汇总一列「加工费」 |
| 损耗量输入 + 可售量派生 + 全损耗确认 | `web/pages/processing/ProcessingOrdersPage.tsx:608-713`、`:677-689` | 设计无 |
| 产出批次号与锁定单价回显 | `contracts/processing-orders.ts:234-242` | 设计无 |
| 归属单号 `attributionDoc` | `contracts/processing-orders.ts:95-97` | 设计无 |
| 取消原因 + If-Match 并发控制 | `contracts/processing-orders.ts:376-388` | 设计无 |
| 操作列（详情/编辑/取消/完成） | `web/pages/processing/ProcessingOrdersPage.tsx:890-929`、`:1546-1575` | 设计列表无操作列（`design/review-logic.md:43` 已指出 5 张单据列表无操作列、进不去详情） |
| 打印发厂联 | `contracts/prints.ts:33-43`；`api/modules/processing/routes.ts:69-80` | `design/说明.md:206` 仍写「加工单发厂联还没做」，与已实现矛盾 |

---

### 3.4 E 销售 + 收款 + 在线支付

#### ① 状态机与允许的动作

**销售单（三态）**

| 事实 | 落点 |
|---|---|
| 枚举复用 `HEADER_STATES` 三态，不另造英文枚举 | `contracts/documents.ts:7`；`contracts/sales-orders.ts:43`；DB `migrations/0013_sales_orders.sql:24-40` |
| 开单直接落 `进行中`，无草稿态 | `api/modules/sales/repo.ts:651` |
| `进行中 → 已完成` / `进行中 → 已取消` / 仅进行中可改 | `api/modules/sales/repo.ts:897-907`、`:805-816`、`:675,696-699,726` |
| 已完成不可回退（无 reopen、无冲正端点，错账走独立冲正模块） | `api/modules/sales/repo.ts:888`、`:905`；`contracts/sales-orders.ts:206-285` 无 reopen/red 路径 |
| 取消前置：有直接下游（C 结算单）不可取消 | `contracts/documents.ts:22-27`、`:29-36`；`api/modules/sales/usecases/sales-orders.ts:612-660` |

**销售收款单（无状态）**：表只有 direction / amount / method / occurred_at / reversal_doc_id / remark / version（`migrations/0014_sales_receipts_returns.sql:103-123`）；方向二值 `收款 | 退款` 且 DB 约束金额符号一致（`:108`、`:119-122`；契约 `contracts/sales-receipts.ts:34,53-57`）；方式四值 `在线支付回调 / 线下转账 / 原路退款 / 冲抵应收`（`contracts/sales-receipts.ts:38-43`）；余额每次 `SUM(amount)` 现算（`api/modules/sales/repo.ts:1011-1018`）；单据已取消后拒绝追加（`api/modules/sales/usecases/sales-receipts.ts:215-221`）。

**在线支付单**：`status` 是自由文本（`CHECK (length(btrim(status)) > 0)`，`migrations/0019_payment_transactions.sql:29`），实际只写 `'已支付'`（`api/modules/payment/usecases/callback.ts:344`）；幂等靠唯一键 `ON CONFLICT DO NOTHING`（`migrations/0019_payment_transactions.sql:34-35`；`api/modules/payment/repo.ts:113-131`）；只接受成功态回调（`callback.ts:117`、`:209`）。

#### ② 端点清单（11 条）

| operationId / 路径 | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| 销售单 list | GET `/api/v1/sales-orders` | sales.read | false | 无 ai 字段 |
| 销售单 create | POST `/api/v1/sales-orders` | sales.create | false | forbid（201） |
| 销售单 detail | GET `/api/v1/sales-orders/{id}` | sales.read | false | 无 ai 字段 |
| 销售单 update | PATCH `/api/v1/sales-orders/{id}` | sales.update | **true** | allow |
| 销售单 complete | POST `/api/v1/sales-orders/{id}/complete` | **sales.update**（不是 ship） | **true** | forbid + reasonRequired |
| 销售单 cancel | POST `/api/v1/sales-orders/{id}/cancel` | sales.delete | **true** | forbid + reasonRequired |
| 收款 list | GET `/api/v1/sales-orders/{id}/receipts` | sales.read | false | 无 ai 字段（返回数组，非分页） |
| 收款 create | POST `/api/v1/sales-orders/{id}/receipts` | sales.update | false（无版本头） | forbid + reasonRequired（201） |
| 支付回调 | POST `/api/v1/payments/{channel}/callback` | payment.create | false | 无 ai 字段（`publicAccess: true`、`idempotent: true`、`audit: none`） |
| `sales.order.print` | GET `/api/v1/sales-orders/{id}/print` | sales.read | false | 未声明 | 
| `sales.order.export` | GET `/api/v1/sales-orders/export` | sales.export | false | 未声明 |

出处：`contracts/sales-orders.ts:206-285`、`contracts/sales-receipts.ts:120-145`、`contracts/payments.ts:25-38`、`contracts/prints.ts:24-28`、`:46-50`。

- **没有**「发起支付 / 取二维码 / 查支付状态 / 关单」路由：`contracts/payments.ts` 全文只有 callback 一条（`:25-38`），且无请求体 schema（原样报文验签，`:8-11`）。
- 契约自述不做改价下限审批端点：「不做改价下限审批的独立端点……本批不在契约里发明任何审批 / `priceFloor` 字段」（`contracts/sales-orders.ts:28-29`、`:169`、`:183`）。

#### ③ 前端落点

| 控件 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| 「导出 CSV」 | `web/pages/sales/SalesOrdersPage.tsx:1385` | `sales.export` | `disabled={!can('export')}`（导出与审计提示 `:1267`） |
| 「+ 新建」 | `web/pages/sales/SalesOrdersPage.tsx:1393` | `sales.create` | `disabled={!can('create') \|\| companyIds.length === 0}` |
| 行内「编辑」 | `web/pages/sales/SalesOrdersPage.tsx:1609-1612` | `sales.update` + `view_price` | `!can('update') \|\| !canViewPrice \|\| status !== '进行中'` |
| 行内「完成」 | `web/pages/sales/SalesOrdersPage.tsx:1618-1622` | `sales.update` | `!can('update') \|\| status !== '进行中'` ⇒ 与后端一致，但**没有 ship 语义** |
| 行内「取消」 | `web/pages/sales/SalesOrdersPage.tsx:1626-1630` | `sales.delete` | `!can('delete') \|\| status !== '进行中'` |
| 详情「完成销售单」 | `web/pages/sales/SalesOrdersPage.tsx:974-977`、`:995-999` | `sales.update` | `order.status !== '进行中' \|\| !canUpdate`，提示「完成需要 sales.update」 |
| 详情「取消销售单」 | `web/pages/sales/SalesOrdersPage.tsx:982-985`、`:1684` | `sales.delete` | `!order.cancelable.allowed \|\| !canCancel` |
| 详情「打印客户联」 | `web/pages/sales/SalesOrdersPage.tsx:992`；`web/pages/sales/sales-api.ts:106-107` | `sales.read` | 无条件 |
| 追加收款开关 | `web/pages/sales/SalesOrdersPage.tsx:647-650`、`:955-956` | `sales.update` | `canAdd && status !== '已取消'`，`canAdd = canUpdate` |
| 收款/金额/单价列脱敏 | `web/pages/sales/SalesOrdersPage.tsx:658-666`、`:702`、`:780`、`:873-874`、`:910-911`、`:927-942` | `sales.view_price` | `canViewPrice ? formatMoney(x) : MASKED_AMOUNT` |
| 破下限失败文案 | `web/pages/sales/SalesOrdersPage.tsx:1525-1531` | — | 只渲染「第 N 行售价低于加权平均批次成本（下限 X）。本批没有审批端点（D20）……」；**全页无放行/提交审批按钮** |
| 经手人列 | `web/pages/sales/SalesOrdersPage.tsx:1595` | — | 直接 `shortId(order.handlerId)`，无 scope 判断 |
| 支付界面 | — | — | **零落点**：`web/pages` 无 payment 目录（`web/lib/access.test.ts:34`、`web/pages/workbench/WorkbenchPage.tsx:37`、`web/lib/domain-words.ts:36`、`web/pages/flow/flow-map.ts:136,151-152` 只有文案与白名单） |

- 完成销售单的真实副作用（同一事务）：行内批次均分扣减（`base = qty / count`，余量给最后一批，`delta = -share`，`api/modules/sales/usecases/sales-orders.ts:739-746`）→ `stockFlowPort().applyAdjustment(sourceDocType:'E')`（`:749-759`）→ 生成 C 结算草稿（`totalSaleAmount = order.totalAmount`、`totalCostAmount = Σ(qty × costFloor)`、提成 0、`commissionOwnerId = order.handlerId`，`:761-776`）→ 改状态（`:778`）。
- 库存不足时整单回滚：`applyStockAdjustment` 在 `FOR UPDATE` 下校验非负，不满足抛 409 `VERSION_CONFLICT`（`api/modules/inventory/services/stock-flow.ts:370-422`、`:415-422`），**文案仍是盘点口吻「盘亏调整后可用量将为负」**。

#### ④ 设计稿对照

**设计有、代码没有**

| 设计稿 | 代码现状 |
|---|---|
| 状态芯片含 `待审核`、`已出库`、`草稿（需放行）`（`design/销售单E.html:22`） | 只有三态（`contracts/sales-orders.ts:43`） |
| 状态筛选含 `草稿`（`design/销售单E.html:20`） | 只有三态（`web/pages/sales/SalesOrdersPage.tsx:1454-1455`） |
| 列表「商品」列（`design/销售单E.html:22`） | 无（`web/pages/sales/SalesOrdersPage.tsx:1564-1571`） |
| 点表头可排序：日期 / 金额 / 状态（`design/销售单E.html:21`） | 全文件无 sort 控件 |
| 破成本下限要有人放行（D20）（`design/销售单E.html:15`、`:22`、`design/对照表-22页.md:16`） | 后端无审批端点（`contracts/sales-orders.ts:28-29,183`；`api/modules/sales/repo.ts:505-515` 直接抛 `VALIDATION_FAILED`），前端无入口 |
| 负责人列「仅老板 / 经理可见」（`design/销售单E.html:24`） | 经手人列所有人可见（`web/pages/sales/SalesOrdersPage.tsx:1595`） |
| 单据类型 chip 切换条（`design/销售单E.html:17-19`） | 页内无该控件 |
| 分页「/ 12 页」（`design/销售单E.html:23`） | cursor 分页，只有上一页/下一页（`:1644-1659`） |
| 销售单详情页 | 无设计稿：`design/单据详情.html:255` 是采购单 A-0024 |

**代码有、设计没画**

| 代码 | 证据 | 设计侧 |
|---|---|---|
| 商品行必选批次、可一引多批（D22） | `web/pages/sales/SalesOrdersPage.tsx:304`、`web/pages/sales/sales-api.ts:124` | 销售单列表无「引用批次」列（`design/review-logic.md:145` 已判 P1） |
| 完成后按行内批次均分扣减 + 二次确认 | `web/pages/sales/SalesOrdersPage.tsx:427`、`:1337-1341` | 无完成/出库交互 |
| 详情抽屉：明细 + 费用 + 收款三块 + 完成/取消/打印 | `web/pages/sales/SalesOrdersPage.tsx:955-1003`、`:859-902`、`:678-684` | 无销售单详情页 |
| 内嵌收款/退款块（方向、方式、发生时间、备注、余额） | `web/pages/sales/SalesOrdersPage.tsx:572-790`、`:729` | `design/销售单E.html` 无「收款」字样 |
| 费用行编辑区 | `web/pages/sales/SalesOrdersPage.tsx:454-461` | 只在 `design/对照表-22页.md:16` 被提及 |
| 版本冲突提示且不自动重提 | `web/pages/sales/SalesOrdersPage.tsx:1214`、`:1313-1331`、`:1517-1521` | 设计无并发冲突态 |
| 无看价禁改（看不到原单价就没法安全改单） | `web/pages/sales/SalesOrdersPage.tsx:873-874`、`:966` | 设计无看价权限态 |
| 在线支付回调入账链（验签→幂等→找单→金额校验→写 `payment_transaction`→写 `sales_receipt`→回填 `receipt_id`） | `api/modules/payment/usecases/callback.ts:274-390` | 全 v0.11 无支付页/二维码/回调状态 |

### 3.5 N 内部交易 + 盘点 + R 客户退货 + S 供应商退货

#### ① 状态机与允许的动作

**N 内部交易单（四态）**

| 起点 | 动作（权限点） | 终点 | 落点 |
|---|---|---|---|
| — | create（`internal_trade.create`） | `进行中` | `api/modules/internal-trade/repo.ts:527` |
| `进行中` | dispatch（**`internal_trade.ship`**） | `在途` | `api/modules/internal-trade/repo.ts:798-830`（`:813-825`） |
| `在途` | receive（`internal_trade.update`） | `已完成` | `api/modules/internal-trade/repo.ts:705-736`（`:719-729`） |
| `在途` | dispatch_revoke（**`internal_trade.ship`**） | `进行中` | `api/modules/internal-trade/repo.ts:866-896` |
| `进行中` / `在途` | cancel（`internal_trade.delete`） | `已取消` | `api/modules/internal-trade/repo.ts:665-703` |
| `已完成` / `已取消` | — | 终态 | 改单 SQL 带 `AND status='进行中'`（`repo.ts:618`） |

- 枚举 `进行中 / 在途 / 已完成 / 已取消`：`contracts/internal-trade-orders.ts:43`；DB `migrations/0015_internal_trade_orders.sql:30`。
- 发货先占在途量：`occupyBatchesForDispatch` 先 `FOR UPDATE` 查 `available_qty`（`repo.ts:752-760`），不足抛 `VERSION_CONFLICT '库存批次可用量不足，无法确认发货'`（`:776-782`），再 `in_transit_qty += qty`（`:787-791`）。
- 撤销发货：`in_transit_qty = in_transit_qty - $1 … AND in_transit_qty >= $1`（`:846-855`）；**必须填原因**（前端 `web/pages/internal-trades/InternalTradeOrdersPage.tsx:653-674`）。
- 到货确认同事务**生成 C 结算草稿**（`sourceDocType:'N'`，`api/modules/internal-trade/usecases/internal-trade-orders.ts:727-740`，实现注册 `api/modules/settlement/services/drafts.ts:99`）。

**盘点（审批三态，不复用单据框架）**

| 起点 | 动作（权限点） | 终点 | 落点 |
|---|---|---|---|
| — | 盘盈 create（`stocktake.create`）/ 盘亏 create（`stocktake.delete`） | `待审批` | `api/modules/inventory/repo-stocktakes.ts:255-286`（`:260-265`） |
| `待审批` | approve（`stocktake.approve`） | `已批准` | `api/modules/inventory/repo-stocktakes.ts:294-314` |
| — | —（无端点） | `已驳回` | **不存在写入路径**：契约明文不做 `stocktake.reject`（`contracts/stocktakes.ts:25-28`），全仓无置 `已驳回` 的 SQL |

- 枚举 `待审批 / 已批准 / 已驳回`（`contracts/stocktakes.ts:45`；DB `migrations/0017_inventory_stocktakes.sql:33`）；仅待审批可审批（`contracts/stocktakes.ts:63-67`；`api/modules/inventory/usecases/stocktakes.ts:402-409`）；阻塞原因 `already_approved / already_rejected`（`contracts/stocktakes.ts:50`）。
- 审批通过的真实副作用：改 `inventory_stocktake.status/approver_id`（`repo-stocktakes.ts:294-314`）→ `applyAdjustment(delta = diffQty, sourceDocType:'stocktake')`（`api/modules/inventory/usecases/stocktakes.ts:434-442`）→ `UPDATE inventory_batch SET inbound_qty = inbound_qty + delta`（`api/modules/inventory/services/stock-flow.ts:425-435`）+ 追加 `inventory_flow`（`:450-454`）。**不生成 I 单冲正**（I 号是盘点单自己的 `stocktake_no`，`stocktakes.ts:326`）。

**R 客户退货 / S 供应商退货（各自三态，只有一条边）**

| 实体 | 枚举 | 唯一流转 | 落点 | 无写入路径的状态 |
|---|---|---|---|---|
| R 客户退货 | `进行中 / 已完成 / 已取消`（`contracts/customer-returns.ts:54`；DB `migrations/0014_sales_receipts_returns.sql:36`） | `进行中 --complete--> 已完成` | `api/modules/sales/repo.ts:1321-1330`；用例 `api/modules/sales/usecases/customer-returns.ts:345-382` | `已取消`（无 cancel/update/delete 端点，`contracts/customer-returns.ts:25-27`） |
| S 供应商退货 | 同上（`contracts/supplier-returns.ts:37`；DB `migrations/0011_supplier_returns.sql:30`） | `进行中 --complete--> 已完成` | `api/modules/purchase/repo.ts:924-933`；用例 `api/modules/purchase/usecases/supplier-returns.ts:277-315` | `已取消`（契约只有 4 条路由，`contracts/supplier-returns.ts:117-161`） |

- R 完成只在 `returnType === '退货退款'` 时逐批次入库（正 `delta`、`sourceDocType:'R'`，`api/modules/sales/usecases/customer-returns.ts:359-374`，按 `batchIds` 均分、余数给最后一批 `:361-366`）；**不写应收冲减、不追加负数退款行、不冲回 E 单毛利/提成**（`migrations/0014_sales_receipts_returns.sql:144-145` 表存在但不用）；前端提示「应收冲减尚未接入（见 #211）」（`web/pages/reversals/CustomerReturnsPanel.tsx:734-735`）。
- S 完成逐批次出库（负 `delta`、`sourceDocType:'S'`，`api/modules/purchase/usecases/supplier-returns.ts:291-307`）；**不冲减应付、无付款/退款落账**，`refund_amount` 只在建单时 `SUM(qty*unit_price)` 聚合（`api/modules/purchase/repo.ts:1019-1040`）。
- **R 建单存在 D47 岗位硬编码**：`api/modules/sales/repo.ts:1333-1364` 判 `e.is_owner OR position.preset_key IN ('owner','manager','finance')`（`:1345-1358`），不满足抛 `FORBIDDEN 'D47：客户退货仅允许老板、经理或财务岗位录入'`（`usecases/customer-returns.ts:303-313`）；S 侧无对应校验。

#### ② 端点清单（21 条）

**N 内部交易（8 条，domain 全 `internal_trade`，module `internal-trade`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| `internal_trade.order.list.read` | GET `/api/v1/internal-trade-orders` | internal_trade.read | false | 未写 policy（audit none） |
| `internal_trade.order.create` | POST `/api/v1/internal-trade-orders` | internal_trade.create | false | forbid |
| `internal_trade.order.detail.read` | GET `/api/v1/internal-trade-orders/{id}` | internal_trade.read | false | 未写 policy |
| `internal_trade.order.update` | PATCH `/api/v1/internal-trade-orders/{id}` | internal_trade.update | **true** | allow |
| `internal_trade.order.cancel` | POST `…/{id}/cancel` | internal_trade.delete | **true** | forbid + reasonRequired |
| `internal_trade.order.dispatch` | POST `…/{id}/dispatch` | **internal_trade.ship** | **true** | forbid + reasonRequired |
| `internal_trade.order.dispatch_revoke` | POST `…/{id}/dispatch-revoke` | **internal_trade.ship** | **true** | forbid + reasonRequired |
| `internal_trade.order.receive` | POST `…/{id}/receive` | internal_trade.update | **true** | forbid + reasonRequired |

出处：`contracts/internal-trade-orders.ts:232-339`（逐条 `:233-244`、`:246-257`、`:258-268`、`:269-282`、`:283-296`、`:297-310`、`:311-324`、`:325-338`）。

**盘点（5 条，domain 全 `stocktake`，module `inventory`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| `stocktake.list.read` | GET `/api/v1/stocktakes` | stocktake.read | false | 未写 policy |
| `stocktake.increase.create` | POST `/api/v1/stocktakes/increases`（盘盈） | stocktake.create | false | forbid |
| `stocktake.decrease.create` | POST `/api/v1/stocktakes/decreases`（盘亏） | **stocktake.delete** | false | forbid |
| `stocktake.detail.read` | GET `/api/v1/stocktakes/{id}` | stocktake.read | false | 未写 policy |
| `stocktake.approve` | POST `/api/v1/stocktakes/{id}/approve` | stocktake.approve | **true** | forbid + reasonRequired |

出处：`contracts/stocktakes.ts:200-266`。无 `stocktake.reject`。

**R 客户退货（4 条，domain 全 `customer_return`，module `sales`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| `customer_return.complete` | POST `/api/v1/customer-returns/{id}/complete` | **customer_return.approve**（HEAD：`create`） | **true** | forbid + reasonRequired |
| `customer_return.list.read` | GET `/api/v1/customer-returns` | customer_return.read | false | 未写 policy |
| `customer_return.create` | POST `/api/v1/customer-returns` | customer_return.create | false | forbid + reasonRequired |
| `customer_return.detail.read` | GET `/api/v1/customer-returns/{id}` | customer_return.read | false | 未写 policy |

出处：`contracts/customer-returns.ts:178-222`（action 在 `:181`）。

**S 供应商退货（4 条，domain 全 `supplier_return`，module `purchase`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy |
|---|---|---|---|---|
| `supplier_return.complete` | POST `/api/v1/supplier-returns/{id}/complete` | **supplier_return.approve**（HEAD：`create`） | **true** | forbid + reasonRequired |
| `supplier_return.list.read` | GET `/api/v1/supplier-returns` | supplier_return.read | false | 未写 policy |
| `supplier_return.create` | POST `/api/v1/supplier-returns` | supplier_return.create | false | forbid + reasonRequired |
| `supplier_return.detail.read` | GET `/api/v1/supplier-returns/{id}` | supplier_return.read | false | 未写 policy |

出处：`contracts/supplier-returns.ts:117-161`（action 在 `:120`）。

- **迁移授权冲突（静态）**：`customer_return` 只 `GRANT SELECT, INSERT` 并 `REVOKE UPDATE, DELETE, TRUNCATE`（`migrations/0014_sales_receipts_returns.sql:135-136`）；`supplier_return` 同（`migrations/0011_supplier_returns.sql:89-90`）；但完成动作都是 `UPDATE … SET status`（`api/modules/sales/repo.ts:1321`、`api/modules/purchase/repo.ts:924`），全量迁移里无补偿 GRANT。对照：盘点给了 UPDATE（`migrations/0017_inventory_stocktakes.sql:72`），N 单给了 UPDATE/DELETE（`migrations/0015_internal_trade_orders.sql:99`）。

#### ③ 前端落点

| 控件 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| N「+ 新建」 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:1094`（提示 `:1107`；无 `ship` 的提示条 `:1112`） | `internal_trade.create` | `disabled={!can('create')}` |
| N 行内「发货」 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:556-563` | `internal_trade.ship` | `canShip && status==='进行中'` |
| N 行内「撤销发货」 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:566-573`（原因校验 `:653-674`；确认文案 `:1024`、`:1041`） | `internal_trade.ship` | `canShip && status==='在途'`；必填原因，「批次可用量被锁定」「不可撤销」 |
| N 行内「到货确认」 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:576-583` | `internal_trade.update`（面板 `canReceive={can('update')}` `:1359-1362`） | `status==='在途'` |
| N 行内「取消」 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:585-596`、`:1303` | `internal_trade.delete` | `disabled={!can('delete') \|\| …}` |
| N 改单 | `web/pages/internal-trades/InternalTradeOrdersPage.tsx:1294` | `internal_trade.update` | `disabled={!can('update') \|\| !canEdit(order.status)}` |
| 冲正页栏目可见性 | `web/pages/reversals/ReversalsPage.tsx:75-78`、`:81-83`、`:133-137` | 各域 `read` | `TABS.filter(spec => allows(scope, spec.domain, 'read'))`；全无权限给整页提示 |
| 冲正页 props 装配（工作区现状） | `web/pages/reversals/ReversalsPage.tsx:141-144`（R）、`:150-153`（S）、`:158-162`（盘点） | R/S：`create/approve/view_price`；盘点：`create/delete/approve` | 见 C1/C2 冲突登记 |
| R「登记客户退货」 | `web/pages/reversals/CustomerReturnsPanel.tsx:272-283` | `customer_return.create` | `disabled={!canCreate \|\| companyId.length===0}`，提示 `:279` |
| R「完成」 | `web/pages/reversals/CustomerReturnsPanel.tsx:718-732` | `customer_return.approve`（工作区）/`create`（HEAD） | `disabled={!canApprove \|\| status!=='进行中' \|\| isPending}`；二次确认「完成后状态变为已完成，不可撤销」`:219-224` |
| R 明细金额 | `web/pages/reversals/CustomerReturnsPanel.tsx:433`、`:576`、`:671`、`:702`、`:705` | `customer_return.view_price` | `canViewPrice` 脱敏 |
| S「登记」/「完成」 | `web/pages/reversals/SupplierReturnsPanel.tsx:240-247`、`:610-624`（金额 `:481`、`:571`） | `supplier_return.create` / `.approve` | 结构同 R |
| 盘点建单 | `web/pages/reversals/StocktakesPanel.tsx:219-227`、`:117-121`、`:317-320`、`:323-329` | `stocktake.create` / `.delete` | 按差异方向自动切权限：`needsIncreaseRight/needsDecreaseRight/rightMissing`；文案随方向切「提交盘盈单/提交盘亏单」 |
| 盘点审批 | `web/pages/reversals/StocktakesPanel.tsx:504-514` | `stocktake.approve` | 仅在 `detail.data.approvable.allowed` 时渲染，`disabled={!canApprove}`，提示「没有 stocktake.approve 权限」`:509-510` |
| 盘点审批后缓存 | `web/pages/reversals/StocktakesPanel.tsx:149-153` | — | 同时失效批次缓存（注释「批准会真的改批次可用量」） |
| 盘点状态筛选 | `web/pages/reversals/StocktakesPanel.tsx:205-208` | — | `待审批/已批准/已驳回`（**「已驳回」在后端不可达**） |

#### ④ 设计稿对照

**设计有、代码没有**

| 设计元素 | 证据 | 代码现状 |
|---|---|---|
| R 单「待审批」状态与筛选；`工作台.html:137,144`「待你审批」徽标；`操作日志.html:101`「客户退货审批 R-0088」 | `design/冲正单据.html:101` | R/S 只有三态，无待审批（`contracts/customer-returns.ts:54`、`contracts/supplier-returns.ts:37`），前端筛选硬编码三态（`CustomerReturnsPanel.tsx:257-260`、`SupplierReturnsPanel.tsx:226-229`） |
| 冲正页「全部」分栏 | `design/冲正单据.html:101`（分段第 4 个按钮） | 代码只有 3 个 tab（`web/pages/reversals/ReversalsPage.tsx:34-53`） |
| 冲正页列「方向 / 方式 / 引用批次 / 数量 / 发生时间」 | `design/冲正单据.html:101` | 三栏字段各不相同，R/S 用「原单号 + 应退金额」（`CustomerReturnsPanel.tsx:554-558`、`SupplierReturnsPanel.tsx:464-467`） |
| 冲正页/盘点行内「审核 / 查看」按钮 | `design/冲正单据.html:101`、`design/盘点.html:100-101` | 行内只有「查看」（`CustomerReturnsPanel.tsx:585-591`、`StocktakesPanel.tsx:408-414`），审批只在详情区（`:504-514`） |
| 盘点页「仓库」列 | `design/盘点.html:100` | 无仓库维度，列的是批次（`StocktakesPanel.tsx:368-373`），且一单一批次 |
| 盘点状态「盘点中 / 已完成」 | `design/盘点.html:98` | 只有 待审批/已批准/已驳回 |
| N 页状态「草稿」 | `design/内部交易单N.html:98` | 四态无草稿，DB CHECK 也不允许（`migrations/0015_internal_trade_orders.sql:30`） |
| N 页状态别名「待发出 / 已接收」 | `design/内部交易单N.html:101` | 代码用 进行中 / 已完成 |
| N 页「导出」按钮 | `design/内部交易单N.html:97` | 全页无 export 入口，`internal_trade.export` 动作用在任何端点 |
| N 页「对接单位」「负责人（仅老板/经理可见）」 | `design/内部交易单N.html:101-103` | 代码列是「发出 → 接收」「经手人」（`InternalTradeOrdersPage.tsx:1249-1257`），无列级隐藏 |
| 「审批后自动生成 I 单冲正并写库存流水」 | `design/盘点.html:103` | 只写流水（`source_doc_type='stocktake'`），不生成 I 单（`api/modules/inventory/usecases/stocktakes.ts:434-442`） |

**代码有、设计没画**

| 代码能力 | 证据 |
|---|---|
| 公司切换下拉（三栏与 N 页均有） | `ReversalsPage.tsx:144-146`、`:152-154`；`StocktakesPage.tsx:17-23` |
| 盘盈/盘亏两个端点两个权限点、按钮随方向切换 | `contracts/stocktakes.ts:213-240`；`StocktakesPanel.tsx:117-131`、`:317-330` |
| 撤销发货必填原因弹层 | `InternalTradeOrdersPage.tsx:600-633` |
| 版本冲突处理与「不自动重提」提示 | `InternalTradeOrdersPage.tsx:844-930`（`describeWriteError` / `staleActionRetryText`） |
| 无看价权限金额脱敏 | `CustomerReturnsPanel.tsx:576`、`:671`；`SupplierReturnsPanel.tsx:481`、`:571` |
| R 两类（退货退款 / 仅退款+纠收款+减成交额）与 S「只退钱无类型」的差异表达 | `contracts/customer-returns.ts:54`、`contracts/supplier-returns.ts:9-12`；`CustomerReturnsPanel.tsx:234-260` |
| 无权限整页/整栏提示态 | `ReversalsPage.tsx:133-137`；`StocktakesPanel.tsx:227` |
| 8 条 N 端点对应的五种行内动作 | `contracts/internal-trade-orders.ts:269-338` |
| 盘点详情展示 `applicant_id` / `approver_id` | `StocktakesPanel.tsx:497-498` |

---

### 3.6 C 结算 + 提成 + 利润报表 + 操作日志 + API 集成 + 订阅计费

#### ① 状态机与允许的动作

| 实体 | 取值 | 允许流转 | 落点 | 备注 |
|---|---|---|---|---|
| 结算单 C | `待确认` / `已结算`（独立枚举，不复用单据三态） | `（无）→ 待确认`（E/N 完成时系统建草稿）；`待确认 --settlement.order.confirm--> 已结算` | `api/modules/settlement/services/drafts.ts:24-95`；`api/modules/settlement/repo.ts:442-455` | 反向边**被 DB CHECK 结构性禁止**：`migrations/0016_settlement_orders.sql:62-67` |
| 提成比例 | 无状态（删旧建新） | create / delete | `api/modules/settlement/repo.ts:366-404`、`:407-423` | 无 update、无 version/If-Match（`contracts/commission-rates.ts:80`） |
| 利润报表 | 无状态（纯聚合） | — | `api/modules/report/usecases/profit-report.ts:136-184` | `unattributedLoss`/`unattributedLossAvailable` 写死 `null`/`false`（`contracts/profit-report.ts:52-61`） |
| 操作日志 | 只追加视图 | — | `api/migrations/0002_platform_m1.sql:26-31`（`audit_log_view`） | 基表只 INSERT，写走 `api/platform/audit/writer.ts` |
| API Token | `active` / `revoked`（+ 过期） | create → revoke（幂等） | `api/modules/platform/usecases/api-tokens.ts:280-361`、`:421-475` | 明文只出现一次，库存 `token_hash = sha256(secret)` |
| 订阅 | `plan` / `expires_at` / 派生 `status` | read / update（必填 `X-Reason`） | `api/modules/platform/usecases/subscription.ts:67-89`、`:122-173` | `dueSoon = daysRemaining <= 30`（`subscription.ts:21`） |

**确认结算的四道前置（按顺序）**：`settlement.approve`（`api/modules/settlement/usecases/settlement-orders.ts:94-101`）→ 必须是人类（`assertHumanConfirmation` `:108-124`，AI 无 `X-Reason` 报 `VALIDATION_FAILED`，带了也抛 `AI_ACTION_FORBIDDEN`）→ 强 ETag（`:173-190`，缺头 428、格式错 409，SQL 再兜一次 `repo.ts:442-455`）→ 状态必须 `待确认`（`:287-362`，文案「一期一单只能结算一次（D19）」）。
**注意口径差**：后端 confirm **不校验 `view_price`**，前端自己加了一道（`web/pages/settlements/SettlementsPage.tsx:565-584`）。

**三样东西分别在哪一步落**：
- 看价：只在读上生效，列表/详情按 `settlement.view_price` 脱敏（`settlement-orders.ts:236-253`、`:256-281`），无权限金额返回 `null`（契约 `contracts/settlement-orders.ts:90-105` 全 nullable），前端显示 `—`（`SettlementsPage.tsx:423-428`）；有权限的详情读取由服务端记 `amount.detail` 审计。
- 毛利：建草稿时算（`drafts.ts:33-62`：`gross_profit = $7-$8`，`gross_margin_rate = CASE WHEN $7=0 THEN 0 ELSE round(($7-$8)/$7,6) END`）；确认时定稿（快照 `related_loss_amount` 并重算 `net_profit`，`repo.ts:442-455`）。
- 提成快照：确认时解析并写入（`resolveCommissionRate` `repo.ts:293-311` → `commission_rate_snapshot`、`commission_amount = round(GREATEST(gross_profit,0)*$5::numeric,6)`）；负毛利提成记 0；比例 `[0,1]`（`migrations/0018_settlement_commission.sql:28`）。

#### ② 端点清单（16 条）

**结算单 C（3 条，domain `settlement`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `settlement.order.list.read` | GET `/api/v1/settlement-orders` | settlement.read | false | 无 | `contracts/settlement-orders.ts:170-180` |
| `settlement.order.detail.read` | GET `/api/v1/settlement-orders/{id}` | settlement.read | false | 无 | `contracts/settlement-orders.ts:181-190` |
| `settlement.order.confirm` | POST `/api/v1/settlement-orders/{id}/confirm` | settlement.approve | **true** | forbid + reasonRequired | `contracts/settlement-orders.ts:191-208` |

无 create / cancel / reverse / export（`contracts/settlement-orders.ts:27-33`「一期只有这三条」）。

**提成比例（3 条，domain `commission`，module `settlement`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `commission.rate.list.read` | GET `/api/v1/commission-rates` | commission.read | false | 无 | `contracts/commission-rates.ts:82-95` |
| `commission.rate.create` | POST `/api/v1/commission-rates` | commission.create | false | forbid + reasonRequired（201） | `contracts/commission-rates.ts:96-108` |
| `commission.rate.delete` | DELETE `/api/v1/commission-rates/{id}` | commission.delete | false | forbid + reasonRequired | `contracts/commission-rates.ts:109-119` |

**利润报表（2 条，domain `profit_report`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `profit_report.read` | GET `/api/v1/reports/profit` | profit_report.read | false | 无 | `contracts/profit-report.ts:91-104` |
| `profit_report.loss.read` | GET `/api/v1/reports/profit/losses` | profit_report.read | false | 无 | `contracts/profit-report.ts:105-117` |

**操作日志（1 条，domain `audit`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `platform.audit.read` | GET `/api/v1/audit-logs` | audit.read | false | 无（audit 标 `sensitive-read`） | `contracts/routes.ts:180-190` |

请求只有 `PageQuerySchema`（无 actor/object/action/时段/result 筛选）。`contracts/audit.ts` 只有 schema 无路由（`audit.ts:18`、`:21-28`、`:30-51`）。

**API 与集成（5 条，domain `api_integration`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `platform.health.read` | GET `/api/v1/health` | api_integration.read | false | 无（`publicAccess`） | `contracts/routes.ts:98-108` |
| `platform.openapi.read` | GET `/api/v1/openapi.json` | api_integration.read | false | 无（`publicAccess`） | `contracts/routes.ts:109-118` |
| `platform.token.create` | POST `/api/v1/api-tokens` | api_integration.create | false | forbid | `contracts/routes.ts:191-202` |
| `platform.token.read` | GET `/api/v1/api-tokens` | api_integration.read | false | 无（`sensitive-read`） | `contracts/routes.ts:203-213` |
| `platform.token.revoke` | DELETE `/api/v1/api-tokens/{id}` | api_integration.delete | **true** | forbid + reasonRequired | `contracts/routes.ts:214-224` |

**订阅计费（2 条，domain `billing`，module `platform`）**

| operationId | method + path | domain.action | requiresIfMatch | ai policy | 出处 |
|---|---|---|---|---|---|
| `billing.subscription.read` | GET `/api/v1/billing/subscription` | billing.read | false | 无 | `contracts/billings.ts:33-44` |
| `billing.subscription.update` | PATCH `/api/v1/billing/subscription` | billing.update | false | **allow** + reasonRequired | `contracts/billings.ts:45-57` |

- 订阅**无 companyId 入参**：后端固定 `principal.companyIds[0]`（`api/modules/platform/routes.ts:188-203`、`:204-245`）。
- Token create 有两道额外校验：`scopeIsSubset(input.scope, principal.scope)`（D52.1）、目标员工同租户且 `status='在职'`（`api/modules/platform/usecases/api-tokens.ts:280-361`）。

#### ③ 前端落点

| 控件 | 文件:行号 | 要求的权限点 | 现在的行为 |
|---|---|---|---|
| 结算页 scope | `web/pages/settlements/SettlementsPage.tsx:251-258` | settlement / commission | `can = allows(scope,'settlement',action)`、`canViewPrice = can('view_price')`、`canCommission = allows(scope,'commission',action)` |
| 「提成比例配置」切换 | `web/pages/settlements/SettlementsPage.tsx:399-407`（面板 props `:410-416`） | `commission.read` | 仅在 `canCommission('read')` 时渲染 |
| 顶部「新建」/「导出」 | `web/pages/settlements/SettlementsPage.tsx:392-421`、`:418-421` | — | **两个按钮都没有**，用文案解释「结算单没有新建按钮」 |
| 行内「确认结算」 | `web/pages/settlements/SettlementsPage.tsx:565-584` | `settlement.approve` + `settlement.view_price` | `disabled = !can('approve') \|\| !canViewPrice \|\| status==='已结算' \|\| confirm.isPending` |
| 详情「确认」 | `web/pages/settlements/SettlementsPage.tsx:208-217` | 同上 | `disabled = !canApprove \|\| !order.confirmable.allowed \|\| !canViewPrice \|\| busy` |
| 无价/无 approve/审计提示 | `web/pages/settlements/SettlementsPage.tsx:423-428`、`:430-434`、`:436-439` | — | 三条横幅 |
| 版本冲突恢复 | `web/pages/settlements/SettlementsPage.tsx:310-326`、`:333-361` | — | `recoverFromStaleVersion` 后再提示；`window.confirm` 三段提示 |
| 结算列表列 | `web/pages/settlements/SettlementsPage.tsx:507-518` | — | 10 列：单号/来源单/总售价/总成本/毛利/毛利率/净毛利/提成/状态/操作（无「对接单位」「日期」） |
| 来源单号映射 | `web/pages/settlements/settlements-api.ts:82-122` | — | 契约只回 `sourceDocId`，前端按类型各拉一页来源单建映射，>200 张退化成 id 前 8 位（`:103-121`） |
| 提成块 | `web/pages/settlements/SettlementsPage.tsx:177-194`、页脚 `:224-227` | `settlement.view_price` | 只读快照；页脚「结算后不可冲正、不可取消，错账走 R 退货」 |
| 报表查询 | `web/pages/report/ProfitReportPage.tsx:96-146`、`:77-89` | `profit_report.read` | 开始/结束日期 + 可见公司，显式校验起止，不用隐式默认期间（`:148-151`） |
| 报表金额 | `web/pages/report/ProfitReportPage.tsx:72-75`、`:39`、`:48` | `profit_report.view_price` | 自行推导 `canViewPrice`，不可见时 `—` + 黄字提示 |
| 报表下钻块 | `web/pages/report/ProfitReportPage.tsx:51-55` | — | 被契约 `unattributedLossAvailable: false` 永久挡住；`profitReportApi.losses`（`web/pages/report/profit-report-api.ts:28-30`）**无任何页面调用** |
| 日志页 | `web/pages/audit/AuditLogsPage.tsx:24-27`、`:29-47`、`:117-127`、`:173-176` | `audit.read` | 单 query；操作人/对象**纯客户端过滤**；6 列（无 requestId）；无分页、无导出；403 才提示「需要 audit.read（敏感读）」`:94-98` |
| Token 列表/创建/撤销 | `web/pages/api-integration/ApiIntegrationPage.tsx:28-31`、`:48-61`、`:72-81`、`:302-332` | `api_integration.read/create/delete` | **创建按钮无 scope 显隐**（`:101-109`），靠服务端 403 兜（文案 `:337-345`）；明文密钥一次性弹窗 |
| 订阅页 | — | `billing.*` | **零落点**：`web/router/routes.ts` 无 `/billing`，`web/lib/access.ts:18-45` 的 `PAGE_SCOPE` 无条目 |

#### ④ 设计稿对照

**设计有、代码没有**

| 设计稿 | 内容 | 代码侧 |
|---|---|---|
| `design/结算单C.html:16` | 「导出」按钮 | 前端无导出按钮（`SettlementsPage.tsx:392-421`），契约无 export 端点（`contracts/settlement-orders.ts:170-208`） |
| `design/结算单C.html:16` | 「+ 新建」按钮 | 明确没有（`SettlementsPage.tsx:418-421`；`settlements-api.ts:4-6`），C 单只由 E/N 完成自动生成 |
| `design/结算单C.html:20` | 状态分段器 草稿/进行中/已完成/已取消 | 只有两态（`contracts/settlement-orders.ts:50`；`settlements-api.ts:127`），筛选是 `<select>`（`SettlementsPage.tsx:443-454`） |
| `design/结算单C.html:22` | 「对接单位」列、「日期」列 | 表头都没有（`SettlementsPage.tsx:507-518`），契约无该字段（`contracts/settlement-orders.ts:90-115`） |
| `design/结算单C.html:24` | 「负责人列仅老板/经理可见」 | 列不存在；详情「提成归属人」按 `commissionOwnerId` 展示不看权限（`SettlementsPage.tsx:188-193`） |
| `design/结算单C.html:15` | 提成未确认显示「待定」；负毛利整行标红 | 无「待定」文案（`SettlementsPage.tsx:550-552`），无行级红底（`:521-588` 只有 `border-b`） |
| `design/报表.html:17-21` | 今天/近 7 天/本月/本季/今年 快捷区间 | 只有两个裸日期输入（`ProfitReportPage.tsx:96-119`） |
| `design/报表.html:22-24` | KPI 总售价 / 总成本 / 毛利·毛利率 | 卡片换成 毛利 / 全损耗损失 / 净毛利（`ProfitReportPage.tsx:30-43`），契约无总售价/总成本字段（`contracts/profit-report.ts:20-50`） |
| `design/报表.html:16`、`:25-29` | 导出 Excel、按期间分段的明细表 + 合计行 | 无按钮无端点；页面完全无表格（`ProfitReportPage.tsx:169-171`） |
| `design/操作日志.html:96`、`:98`、`:103` | 导出日志、结果分段器 成功/失败、失败行「请求编号」 | 均无（`AuditLogsPage.tsx:61-76`、`:117-127`）；`AuditLogSchema` 里有 `requestId` 却没渲染（`contracts/audit.ts:30-51`） |
| `design/API与集成.html:98`、`:103` | 状态分段器 生效中/已过期/已吊销、全量读写密钥标红 | 无（`ApiIntegrationPage.tsx:171-218`） |
| （订阅计费） | — | 设计稿没有这一页，代码也没有页面 |

**代码有、设计没画**

| 代码 | 内容 | 设计侧 |
|---|---|---|
| `SettlementsPage.tsx:507-518` | 「来源单」「净毛利」两列 | `design/结算单C.html:22` 表头无这两列（`design/review-logic.md:48` 亦已指出） |
| `SettlementsPage.tsx:399-416` + `CommissionRatesPanel.tsx:1-391` | 提成比例配置面板（新建/删除、生效日、百分比输入→decimal `:148`、`:159`） | 设计只有「提成」一列（`design/结算单C.html:22`） |
| `SettlementsPage.tsx:423-439` | 无价横幅 / 无 approve 提示 / amount.detail 审计提示 | 设计只有一句 note（`design/结算单C.html:24`） |
| `SettlementsPage.tsx:310-326` | 版本冲突后「已刷新到最新状态」提示 | 设计无并发冲突态 |
| `ProfitReportPage.tsx:45-49` | 期间 + 参与汇总的已结算单数 | `design/报表.html:22-24` 的 KPI 无该指标 |
| `ProfitReportPage.tsx:51-55` | 未归属损失下钻占位块（被契约关死） | 设计无此块 |
| `AuditLogsPage.tsx:29-47`、`:54-59` | 客户端操作人/对象筛选、「敏感读 · 查询本身会被记录」徽标 | `design/操作日志.html:98` 只有一个搜索框 + 结果分段器 |
| `ApiIntegrationPage.tsx:84-87`、`:251-277`、`:302-332` | 「可勾域 = 你自己有权限的域」勾选器 + 明文密钥一次性弹窗 + 复制 | `design/API与集成.html` 无创建表单、无弹窗 |

---

## 4. 缺口总表

> 全量 62 条，去重后按 P0 / P1 / P2 三档。**P0 15 条 / P1 32 条 / P2 15 条。**
> 编号规则：`P<档>-<序号>`；每条一行，可独立开一张 issue。
> 「是否需要改契约」= 是否要动 `packages/contracts/**` 与 `docs/decisions.md`；填「否」的只改实现或设计。

### 4.1 P0（口径错、点了报错、权限点对不上）

| 编号 | 缺口一句话 | 证据 `文件:行号` | 建议归属 | 需要改契约 |
|---|---|---|---|---|
| P0-01 | 采购单「完成」的权限点三处不一致：契约写 `approve`、后端实判 `update`、前端按 `approve` 显隐 ⇒ 两种人都点到错的那一侧 | `contracts/purchase-orders.ts:223`；`api/modules/purchase/usecases/purchase-orders.ts:432`；`web/pages/purchase/PurchaseOrdersPage.tsx:1205` | 主线 TianLingBy | 是 |
| P0-02 | 采购完成把明细单价直接当批次锁价，`purchase_order.fee` 完成后再无消费方，D5 的「(货款+运费+杂费)÷入库数量」未落地 | `api/modules/purchase/usecases/purchase-orders.ts:449`；`contracts/purchase-orders.ts:221-227` | 主线 TianLingBy | 否 |
| P0-03 | R/S「完成」的 action 在 HEAD 是 `create`、工作区已改 `approve`，改动未提交、无回归测试；前端 `canApprove` 依赖这次改动 | `contracts/customer-returns.ts:181`；`contracts/supplier-returns.ts:120`；`api/modules/sales/usecases/customer-returns.ts:348`；`api/modules/purchase/usecases/supplier-returns.ts:280`；`web/pages/reversals/ReversalsPage.tsx:141-153` | 主线 TianLingBy | 是 |
| P0-04 | `customer_return` / `supplier_return` 两张表的 UPDATE 被 REVOKE，而「完成」就是 `UPDATE … SET status`；运行时角色为 `qingdan_app` 时会被 PG 直接拒 | `migrations/0014_sales_receipts_returns.sql:135-136`；`migrations/0011_supplier_returns.sql:89-90`；`api/modules/sales/repo.ts:1321`；`api/modules/purchase/repo.ts:924` | 主线 TianLingBy | 是（迁移） |
| P0-05 | 客户退货建单硬编码岗位：`e.is_owner OR position.preset_key IN ('owner','manager','finance')`，与「没有职位、只有权限点」的铁律冲突；S 侧无此校验，两侧不对称 | `api/modules/sales/repo.ts:1333-1364`；`api/modules/sales/usecases/customer-returns.ts:303-313` | 主线 TianLingBy | 是 |
| P0-06 | 销售单「完成」= 出库，却挂在 `sales.update` 上，没有独立 `ship` 端点与 `sales.ship` 权限点 ⇒ 「能改单的人就能出货」 | `contracts/sales-orders.ts:272-283`；`api/modules/sales/usecases/sales-orders.ts:702-703` | 主线 TianLingBy | 是 |
| P0-07 | 加工单金额没有服务端脱敏，`processing.view_price` 只在前端遮罩，接口照旧返回明文金额 | `web/pages/processing/ProcessingOrdersPage.tsx:1334-1341`；`api/modules/processing/usecases/processing-orders.ts:96-103` | 梁海俊 Vince-Leong | 是（金额字段需声明可空） |
| P0-08 | 加工详情面板「编辑」只判 `status==='进行中'` 不判 `can('update')`；「打印发厂联」完全无权限判定 | `web/pages/processing/ProcessingOrdersPage.tsx:898-905`、`:914-920` | 李祖怡 lozy66 | 否 |
| P0-09 | 主数据页「新增 / 编辑 / 停用 / 报价 / 记录报价」五个写入口全部无条件渲染，无权限的人点了只能吃 403 | `web/pages/masterdata/MasterdataPage.tsx:626-632`、`:733-739`、`:741-755`、`:399-405` | 赖皓妍 karryL921 | 否 |
| P0-10 | 权限设置页「新建岗位 / 编辑模板 / 停用」全线无 scope 显隐，只靠 403 文案分流 | `web/pages/permissions/PermissionsPage.tsx:148-154`、`:242-259`、`:446` | 温汇敏 2696708617-web | 否 |
| P0-11 | 主数据四实体的 `status` 是可写字段、软删除 SQL 无 `AND status='启用'` 守卫 ⇒ 任何 `update` 权限即可把停用记录改回启用，已停用记录可被反复删除并 `version+1` | `contracts/products.ts:62`；`api/modules/masterdata/repo.ts:80-91`、`:299-309`；`repo-customers.ts:291-300`；`repo-suppliers.ts:291-300`；`repo-processors.ts:355-364` | 梁海俊 Vince-Leong | 是 |
| P0-12 | `referenced_qty` / `pending_execution_qty` 在 `api/` 非测试代码里没有任何写入语句，库存页「已引用 / 在途 / 待执行 / 可用量」四列里两列恒为 0，可用量口径因此虚高 | `migrations/0008_inventory_core.sql:39-49`；`api/modules/inventory/repo.ts:149-153` | 梁海俊 Vince-Leong | 否 |
| P0-13 | 「确认结算」的看价门禁只活在前端，后端 confirm 用例全文不校验 `view_price` ⇒ 直调接口即可在看不到毛利的情况下签结算 | `web/pages/settlements/SettlementsPage.tsx:565-584`；`api/modules/settlement/usecases/settlement-orders.ts:287-362` | 主线 TianLingBy | 否 |
| P0-14 | 盘点「已驳回」是死态：DB 允许、契约给了阻塞原因、前端有筛选页签，但没有任何写入路径（不做 `stocktake.reject`） | `contracts/stocktakes.ts:45`、`:50`、`:25-28`；`migrations/0017_inventory_stocktakes.sql:33`；`web/pages/reversals/StocktakesPanel.tsx:208` | 主线 TianLingBy | 是 |
| P0-15 | 销售单完成失败时把库存服务的盘点口吻文案直接透给用户：「409 VERSION_CONFLICT · 盘亏调整后可用量将为负」，与销售场景无关 | `api/modules/inventory/services/stock-flow.ts:415-422` | 梁海俊 Vince-Leong | 否 |

### 4.2 P1（功能缺失，影响主流程闭环）

| 编号 | 缺口一句话 | 证据 `文件:行号` | 建议归属 | 需要改契约 |
|---|---|---|---|---|
| P1-01 | 采购完成不回传任何入库结果（无 `batchIds` / `batchNo`），设计稿「入库批次 B-2026-1088」无处取值 | `contracts/purchase-orders.ts:122-147`；`design/单据详情.html:282` | 主线 TianLingBy | 是 |
| P1-02 | 采购完成入参是空 body，不接受实收数量，「到货数量差异的二次确认」在前后端都没有落点 | `contracts/purchase-orders.ts:226`；`design/业务全流程图.html:101` | 主线 TianLingBy | 是 |
| P1-03 | 采购单完成后只失效 `['purchase-orders']`，不刷 `['inventory','batches']` / `['inventory','flows']` ⇒ 刚入库的批次在库存页看不到 | `web/pages/purchase/PurchaseOrdersPage.tsx:831-836` | 李祖怡 lozy66 | 否 |
| P1-04 | 库存缺仓库维度：设计要「仓库」列与筛选，`inventory_batch` 建表无 `warehouse_id` | `migrations/0008_inventory_core.sql:27-58`；`design/库存.html:22`、`:26-27` | 梁海俊 Vince-Leong | 是 |
| P1-05 | 设计有「录入入库」抽屉，契约明令不登记库存写端点 ⇒ 二选一：删设计，或加「收料/入库单」单据（不许开直改库存的口子） | `contracts/inventory.ts:8-10`、`:148`；`design/库存.html:30-41` | 主线 TianLingBy | 是 |
| P1-06 | 导出能力整体缺失：采购单、库存、加工单、结算单、利润报表、操作日志六个页面设计都有「导出」，契约一条 export 端点都没有（销售单除外） | `contracts/purchase-orders.ts:220-291`；`contracts/inventory.ts:150-186`；`contracts/processing-orders.ts:324-403`；`contracts/settlement-orders.ts:170-208`；`contracts/profit-report.ts:91-117`；`contracts/routes.ts:180-190` | 主线 TianLingBy | 是 |
| P1-07 | 加工发料（原料出库给加工厂）没有端点、没有单据、没有 `ship` 权限点；材料一直挂在本司库存直到 complete 才按 `delta=-qty` 扣减 | `contracts/processing-orders.ts:324-403`；`api/modules/processing/usecases/processing-orders.ts:533-541` | 梁海俊 Vince-Leong | 是 |
| P1-08 | 加工产出入库、加工厂回传成品/损耗、核对入库三个动作全无端点与字段；产出批次由 complete 内部直接落库 | `api/modules/processing/usecases/processing-orders.ts:548-566`；`api/modules/inventory/services/stock-flow.ts:314-350`；`design/加工单B.html:15` | 梁海俊 Vince-Leong | 是 |
| P1-09 | 损耗率阈值审批不存在：无 threshold 字段、无审批态、无端点，只有全损耗 `confirmFullLoss` 硬确认 | `contracts/processing-orders.ts:206-210`；`api/modules/processing/usecases/processing-orders.ts:520` | 梁海俊 Vince-Leong | 是 |
| P1-10 | 材料投入合计校验只在契约层（`各行 qty 合计 = inputQty`），repo 只校验批次归属 ⇒ 绕过契约即可写入不平的投入 | `contracts/processing-orders.ts:81-89`；`api/modules/processing/repo.ts:478-500` | 梁海俊 Vince-Leong | 否 |
| P1-11 | 加工状态机只有三态，设计要的「草稿 / 已发料 / 待核对」无处落；要支持发料与回传必须先扩枚举 + DB CHECK + 迁移 | `contracts/processing-orders.ts:49`；`migrations/0012_processing_orders.sql:39-40`；`design/加工单B.html:20-22` | 主线 TianLingBy | 是 |
| P1-12 | 加工列表没有损耗率 / 可售量 / 产出批次列，完成后的损耗与产出在列表层不可见 | `web/pages/processing/ProcessingOrdersPage.tsx:1490-1609` | 李祖怡 lozy66 | 否 |
| P1-13 | 破成本下限审批三件套全缺：无 `sales.approve` 端点、无 pending 审批表与「草稿（需放行）」态、前端只有一句文案 | `contracts/sales-orders.ts:28-29`、`:183`；`api/modules/sales/repo.ts:505-515`；`web/pages/sales/SalesOrdersPage.tsx:1525-1531` | 主线 TianLingBy | 是 |
| P1-14 | 客户扫码付款的上游整段缺失：无预下单 / 取二维码 / 查支付状态 / 关单；商户配置只用于验签 | `contracts/payments.ts:25-38`；`api/modules/payment/services/merchant-config.ts:46-72` | 主线 TianLingBy | 是 |
| P1-15 | 销售单详情里的收款块在用例里硬编码空（`receipts: []`、`receiptBalance:'0'`），靠路由层覆盖合并；契约 detail schema 未声明这两个字段 ⇒ mock 与前端类型对不齐 | `api/modules/sales/usecases/sales-orders.ts:388-411`；`api/modules/sales/routes.ts:102-114` | 主线 TianLingBy | 是 |
| P1-16 | 退款/冲正没有在线链路，`reversal_doc_id` 选填无外键；退款不校验是否超出已收，后端不给「可退上限」字段前端无法禁用 | `migrations/0014_sales_receipts_returns.sql:113-114`；`api/modules/payment/usecases/callback.ts:117`、`:209`；`api/modules/sales/usecases/sales-receipts.ts:192-240` | 主线 TianLingBy | 是 |
| P1-17 | N 单到货确认已生成 C 结算草稿，但两处注释仍写「N 单未接线 / 不做自动生成 C 单草稿」，下一个人会按错的写 | `api/modules/internal-trade/usecases/internal-trade-orders.ts:727-740`；`api/modules/settlement/services/drafts.ts:34-36`；`contracts/internal-trade-orders.ts:31` | 主线 TianLingBy | 否 |
| P1-18 | R/S 没有「待审批」态与「提交 / 驳回」端点，设计的「提交 → 审批」两步在库里存不下；现有 `complete` 是一次性把进行中推到已完成 | `contracts/customer-returns.ts:54`；`contracts/supplier-returns.ts:37`；`migrations/0014_sales_receipts_returns.sql:36`；`migrations/0011_supplier_returns.sql:30` | 主线 TianLingBy | 是 |
| P1-19 | 客户退货完成只入库、不落账：无应收冲减、不追加负数退款行、不按 D36 冲回原 E 单毛利与提成 | `api/modules/sales/usecases/customer-returns.ts:359-374`；`web/pages/reversals/CustomerReturnsPanel.tsx:734-735` | 主线 TianLingBy | 是 |
| P1-20 | 供应商退货完成只出库，不冲减应付；模型里根本没有应付账表（`payment_transaction` 只是渠道回调记录） | `api/modules/purchase/usecases/supplier-returns.ts:291-307`；`migrations/0019_payment_transactions.sql:21-36` | 主线 TianLingBy | 是 |
| P1-21 | 盘点审批只写 `inventory_flow`（`source_doc_type='stocktake'`），不生成设计稿承诺的 I 单冲正；要保留该交互需新增派生写入路径 | `api/modules/inventory/usecases/stocktakes.ts:434-442`；`design/盘点.html:103` | 梁海俊 Vince-Leong | 否 |
| P1-22 | 结算单确认后不能撤销：无 reverse/cancel 端点与第三态，且 DB CHECK 要求「待确认 ⇒ snapshot IS NULL」，回退必须清快照而没有任何代码路径清它 | `migrations/0016_settlement_orders.sql:62-67`；`api/modules/settlement/repo.ts:442-455`；`web/pages/settlements/SettlementsPage.tsx:224-227` | 主线 TianLingBy | 是 |
| P1-23 | 契约没有 `sourceDocNo`，结算列表的「来源单」靠前端按类型各拉一页建映射，超过 200 张退化成 id 前 8 位 | `web/pages/settlements/settlements-api.ts:82-121`；`contracts/settlement-orders.ts:90-115` | 主线 TianLingBy | 是 |
| P1-24 | 订阅计费前端零落点：无 `/billing` 路由、`PAGE_SCOPE` 无条目、无页面、无侧栏项，而后端两条端点已实现 | `web/router/routes.ts`；`web/lib/access.ts:18-45`；`api/modules/platform/routes.ts:188-245` | 赖皓妍 karryL921 | 否 |
| P1-25 | 员工页缺「新建员工 / 编辑 / 停用」三个入口，`POST`、`PATCH`、`DELETE` 三条端点已就绪却无人调用 | `web/pages/employees/EmployeesPage.tsx:148-156`；`contracts/employees.ts:69-107` | 赖皓妍 karryL921 | 否 |
| P1-26 | 员工列表无服务端状态筛选，keyword 纯前端本地过滤（姓名/工号/手机掩码）⇒ 翻页后过滤结果不可信 | `web/pages/employees/EmployeesPage.tsx:41-50`；`api/routes.ts:90-95` | 赖皓妍 karryL921 | 否 |
| P1-27 | 员工与岗位的停用不可逆（`update` 入参都不含 `status`，无复活端点），契约里也没写明「停用不可恢复」 | `contracts/employees.ts:46-55`；`contracts/positions.ts:108-114`；`api/modules/platform/usecases/employees.ts:737-741` | 主线 TianLingBy | 是 |
| P1-28 | 公司没有 `status` 字段，设计稿的「停用公司（该公司员工不能登录）」在代码里没有字段也没有端点 | `contracts/companies.ts:21-31`、`:67-103`；`design/公司管理.html` | 主线 TianLingBy | 是 |
| P1-29 | 公司码格式冲突：契约 `^[0-9]{4}$`（服务端 `padStart(4,'0')`）与设计稿 `HQ` / `HD` / `HN` 二选一 | `contracts/companies.ts:17-19`；`api/modules/platform/usecases/companies.ts:192`；`design/公司管理.html` | 主线 TianLingBy | 是 |
| P1-30 | 权限矩阵动作数不一致：设计只画 4 个动作，代码 7 个（8 动作去掉 `view_price`）⇒ 前端照设计写会漏 3 个权限点 | `contracts/positions.ts:47`；`design/权限设置.html` | 温汇敏 2696708617-web | 是 |
| P1-31 | 四处注释与实现相反（「完成/入库未实现、点了不动库存」），其中包含契约头注释与加工 routes 头注释，属交付前必须清掉的误导信息 | `contracts/purchase-orders.ts:24-25`；`api/modules/purchase/repo.ts:388-393`；`web/pages/purchase/purchase-api.ts:11`；`web/pages/purchase/PurchaseOrdersPage.tsx:9`；`api/modules/processing/routes.ts:24-26` | 主线 TianLingBy | 否 |
| P1-32 | 提成快照缺 `commission_rate_id`，已结算单无法追溯「这条比例用的是哪条配置」 | `api/modules/settlement/repo.ts:442-455`；`migrations/0018_settlement_commission.sql:16` | 主线 TianLingBy | 是 |

### 4.3 P2（体验与一致性）

| 编号 | 缺口一句话 | 证据 `文件:行号` | 建议归属 | 需要改契约 |
|---|---|---|---|---|
| P2-01 | N 页无「导出」入口、「草稿」态不存在；`internal_trade.export` 动作被定义了却没有端点 | `design/内部交易单N.html:97-98`；`web/pages/internal-trades/InternalTradeOrdersPage.tsx:1249-1257` | 李祖怡 lozy66 | 否 |
| P2-02 | 冲正页缺「全部」分栏，也缺设计稿的「方向 / 方式 / 引用批次 / 数量 / 发生时间」抽象列（三栏字段各不同） | `design/冲正单据.html:101`；`web/pages/reversals/ReversalsPage.tsx:34-53` | 李祖怡 lozy66 | 否 |
| P2-03 | 盘点没有行内「审核」按钮（只在详情区），且列表 item 未给 `approvable` / `version`，行内审批做不出来 | `design/盘点.html:100-101`；`web/pages/reversals/StocktakesPanel.tsx:504-514`；`contracts/stocktakes.ts:201-212` | 李祖怡 lozy66 | 是 |
| P2-04 | 结算列表缺「对接单位」「日期」列，提成未确认不显示「待定」，负毛利不整行标红 | `design/结算单C.html:22`、`:24`、`:15`；`web/pages/settlements/SettlementsPage.tsx:507-518`、`:550-552`、`:521-588` | 赖皓妍 karryL921 | 否 |
| P2-05 | 报表缺快捷区间、总售价/总成本 KPI、按期间分段的明细表与合计行 | `design/报表.html:17-29`；`web/pages/report/ProfitReportPage.tsx:30-43`、`:96-119`、`:169-171` | 赖皓妍 karryL921 | 否 |
| P2-06 | 日志页缺结果分段器与 requestId 列；服务端筛选（actor/object/action/时段/result）未进契约，前端只能两个输入框本地过滤 | `design/操作日志.html:98`、`:103`；`web/pages/audit/AuditLogsPage.tsx:29-47`、`:117-127`；`contracts/routes.ts:180-190` | 赖皓妍 karryL921 | 是 |
| P2-07 | Token 生命周期只有建/列/撤：缺编辑 scope、续期、密钥轮换、IP 白名单写入、webhook 配置；创建按钮也无 scope 显隐 | `contracts/routes.ts:191-224`；`web/pages/api-integration/ApiIntegrationPage.tsx:101-109` | 赖皓妍 karryL921 | 是 |
| P2-08 | 订阅只能看第一家公司（后端固定 `companyIds[0]`，契约无 `companyId` 入参） | `api/modules/platform/routes.ts:188-203`；`contracts/billings.ts:33-44` | 主线 TianLingBy | 是 |
| P2-09 | 员工页岗位模板查询带 `retry:false` 降级（端点已上线应去掉）；「公司·岗位」多值用 `、` 串一行；报价表单缺字段级校验 | `web/pages/employees/EmployeesPage.tsx:28-32`、`:133`；`web/pages/masterdata/MasterdataPage.tsx:370-412` | 赖皓妍 karryL921 | 否 |
| P2-10 | 权限设置页缺 `presetKey` 筛选下拉（后端 `PositionListQuerySchema` 已支持） | `contracts/positions.ts:88-90`；`web/pages/permissions/PermissionsPage.tsx:203-227` | 温汇敏 2696708617-web | 否 |
| P2-11 | 加工厂列表缺「工序 / 单价」列，工序价只在下方报价面板可见 | `design/加工厂档案.html`；`web/pages/masterdata/MasterdataPage.tsx:700-707`、`:337-448` | 赖皓妍 karryL921 | 否 |
| P2-12 | 销售列表缺排序 UI 与「商品」列；经手人列无权限显隐（设计要求仅老板/经理可见） | `design/销售单E.html:21-22`、`:24`；`web/pages/sales/SalesOrdersPage.tsx:1564-1571`、`:1595` | 李祖怡 lozy66 | 否 |
| P2-13 | 销售单的 print / export 端点登记在 `prints.ts`，不在 `sales-orders.ts`，前端读销售契约时看不到这两个端点 | `contracts/prints.ts:24-28`、`:46-50`；`web/pages/sales/sales-api.ts:106-110` | 主线 TianLingBy | 是 |
| P2-14 | 主数据关键字检索只匹配 `name` / `aliases`，`product_no` 不参与，按编号搜不到商品 | `api/modules/masterdata/repo.ts:161-168` | 梁海俊 Vince-Leong | 否 |
| P2-15 | 从结算单跳不到对应的 R 退货单：库里有 `original_settlement_order_id`，但没有「按 C 单查 R 单」的端点 | `api/modules/sales/repo.ts:1103`、`:1502`；`web/pages/settlements/SettlementsPage.tsx:224-227` | 主线 TianLingBy | 是 |

### 4.4 待核项（不计入 62 条，先查清再开工）

| 项 | 现状 | 动作 |
|---|---|---|
| 第 24 个 domain | 6 份素材只能确证 23 个 domain；项目根 `AGENTS.md` 记 `contracts/domains.ts` 共 24 个 | 打开 `contracts/domains.ts` 核对全表，把第 24 个 domain 的名字与中文名补进 2.2 |
| 「验收」是否要独立动作 | `processing` 的「验收」就是 complete，没有 `accept` 动作 | 若要独立，属新增动作，必须同时改 `contracts/domains.ts` 与 `docs/decisions.md` |

---

## 5. 归属与派工建议

**前置说明（必须先知道的边界事实）**：下列后端模块在固定分工里没有对应人 —— `apps/api/src/modules/purchase/**`、`apps/api/src/modules/sales/**`、`apps/api/src/modules/settlement/**`、`apps/api/src/modules/report/**`、`apps/api/src/modules/payment/**`。本报告把这些模块里的 P0/P1 统一归给 **主线 TianLingBy**（理由是它们都伴随跨模块状态机或契约改动）；若要下放，在 issue 上改派即可，不要把同一条拆给两个人。

### 5.1 P0（15 条）

| 归属 | 条数 | 编号 |
|---|---|---|
| 主线 TianLingBy | 8 | P0-01、P0-02、P0-03、P0-04、P0-05、P0-06、P0-13、P0-14（含迁移与状态机） |
| 梁海俊 Vince-Leong | 4 | P0-07、P0-11、P0-12、P0-15 |
| 李祖怡 lozy66 | 1 | P0-08 |
| 温汇敏 2696708617-web | 1 | P0-10 |
| 赖皓妍 karryL921 | 1 | P0-09 |
| 何永上 Meow-Yay | 0 | — |

> 合计 8（主线）+ 4（梁海俊）+ 1（李祖怡）+ 1（温汇敏）+ 1（赖皓妍）= 15。

### 5.2 P1（32 条）

| 归属 | 条数 | 编号 |
|---|---|---|
| 主线 TianLingBy | 20 | P1-01、P1-02、P1-05、P1-06、P1-11、P1-13、P1-14、P1-15、P1-16、P1-17、P1-18、P1-19、P1-20、P1-22、P1-23、P1-27、P1-28、P1-29、P1-31、P1-32 |
| 梁海俊 Vince-Leong | 6 | P1-04、P1-07、P1-08、P1-09、P1-10、P1-21 |
| 李祖怡 lozy66 | 2 | P1-03、P1-12 |
| 温汇敏 2696708617-web | 1 | P1-30 |
| 赖皓妍 karryL921 | 3 | P1-24、P1-25、P1-26 |
| 何永上 Meow-Yay | 0 | — |

> 合计 20（主线）+ 6（梁海俊）+ 2（李祖怡）+ 1（温汇敏）+ 3（赖皓妍）= 32。`P1-06` 的日志页导出属前端配合，不单独计条。

### 5.3 按人汇总（P0 + P1）

| 人 | 负责范围 | P0 | P1 | 合计 |
|---|---|---|---|---|
| 主线 TianLingBy | `packages/contracts/**`、`apps/api/src/platform/**`、`apps/api/migrations/**`、跨模块状态机与契约、`docs/decisions.md` | 8 | 20 | 28 |
| 梁海俊 Vince-Leong | `apps/api/src/modules/{masterdata,inventory,processing,internal-trade}/**` | 4 | 6 | 10 |
| 温汇敏 2696708617-web | `apps/api/src/modules/platform` 账号权限域 + 权限设置页 | 1 | 1 | 2 |
| 李祖怡 lozy66 | `apps/web/src/pages/{purchase,processing,sales,internal-trades,reversals,inventory}/**` | 1 | 2 | 3 |
| 赖皓妍 karryL921 | `apps/web/src/pages/**` 其余页面 + `design/**` | 1 | 3 | 4 |
| 何永上 Meow-Yay | `apps/web/src/components/**` + 设计规范 | 0 | 0 | 0 |

### 5.4 派工顺序建议（按阻塞关系，不是按优先级重排）

1. **先做契约层**（主线）：P0-01、P0-06、P1-13、P1-11、P1-01 —— 这些不定，前端的显隐与状态判断全部要返工。
2. **再做数据库层**（主线 + 梁海俊）：P0-04、P0-11、P1-04、P1-22 —— 迁移不落地，功能写完了也跑不起来。
3. **权限口径统一**（主线 + 温汇敏）：P0-05、P0-03、P1-30 —— 一次性把「没有职位、只有权限点」落到代码与设计稿。
4. **前端补齐显隐三态**（李祖怡 + 赖皓妍 + 温汇敏）：P0-08、P0-09、P0-10 —— 这批不依赖契约，可并行。
5. **服务端安全收口**（梁海俊 + 主线）：P0-07、P0-12、P0-13、P0-15 —— 看价与库存口径，直接对外。

---

## 6. 前端写页面的检查清单

> 逐条勾。任一条不满足就不用提 MR。

- [ ] 1. 每个按钮都有三态：**有权限 + 状态允许**（可点）/ **有权限 + 状态不允许**（禁用 + 说明当前状态）/ **无权限**（禁用 + 明写缺哪个权限点，如「缺少 purchase.delete 权限」）。
- [ ] 2. 权限判断一律 `allows(scope, DOMAIN, ACTION)`；全文件搜不到 `role ===`、`isAdmin`、`isManager`、`preset_key`、`职位`。
- [ ] 3. 禁用态优先级写死：先判权限，再判状态，最后判 pending；不允许出现「无权限时显示成状态不允许」的文案。
- [ ] 4. 需要填原因的动作（取消、停用、撤销发货、驳回、确认结算、调订阅）一律用**内联输入区或抽屉里的 textarea**，不用 `window.prompt`。
- [ ] 5. 原因必填的按钮在原因为空时禁用，并给出「原因必填」的就地提示，不靠提交后 400。
- [ ] 6. 所有 `requiresIfMatch: true` 的写操作都带 `If-Match: "<version>"`；header 构造函数统一一处实现（参考 `web/pages/purchase/purchase-api.ts:46-48`）。
- [ ] 7. 收到 **428 `PRECONDITION_REQUIRED`** → 提示「数据已变化，正在重新读取」并自动重读一次，不算错误。
- [ ] 8. 收到 **409 `VERSION_CONFLICT`** → 重新拉最新详情、展示差异、**不自动重提**；给用户一个明确的「按最新版本重填」按钮。
- [ ] 9. 收到 **403** → 翻成人话「缺 X 权限」，不是「无权操作」；X 必须是 `domain.action` 的真实键名。
- [ ] 10. 拿到 **422 / `VALIDATION_FAILED`** → 把 `details` 里的行号与原因渲染到对应字段旁，不整页 toast 了事。
- [ ] 11. 金额字段一律 `canViewPrice ? formatMoney(x) : MASKED_AMOUNT`；无价时**不显示 0**，显示 `—`。
- [ ] 12. 无 `view_price` 时，凡需要读到原单价才能正确操作的写动作（改单、完成、确认结算）一律禁用，并在旁边写清原因。
- [ ] 13. 提交时不把被掩码的金额回传服务端（参考 `web/pages/masterdata/MasterdataPage.tsx:516-530` 的做法）。
- [ ] 14. 状态值只用契约枚举（`HEADER_STATES` / `SETTLEMENT_ORDER_STATES` / `stocktake` 三态 / N 单四态）；**前端不许自造状态**（草稿、待审核、已出库、已入库、加工中、待核对一律不写进 `switch`）。
- [ ] 15. 状态筛选选项与后端枚举逐项对齐；后端没有的值不许出现在下拉里（盘点「已驳回」在补端点前不许给筛选页签）。
- [ ] 16. 写操作成功后按域失效缓存，且**跨域也要刷**：采购/加工/销售/退货完成 → 同时失效 `['inventory','batches']` 与 `['inventory','flows']`。
- [ ] 17. AI 禁止的动作（`forbid`）不在 UI 上提供「让 AI 代做」的入口；人类凭据失效时给「请用人工账号操作」。
- [ ] 18. `dryRun` 类操作（权限覆盖预演）与真实保存在 UI 上必须视觉可区分，按钮文案含「预演 / 不落库」。
- [ ] 19. 列表分页统一 cursor 式（上一页 / 下一页）；不实现「第 N 页」跳转（后端不支持总页数）。
- [ ] 20. 空态文案写清「为什么空」与「下一步做什么」，不写「暂无数据」四个字了事。
- [ ] 21. 列表列里凡设计标注「仅老板/经理可见」的字段（负责人、经手人），在权限点确定前**不要先渲染**，等 `view_owner` 一类 scope 落地再加。
- [ ] 22. 注释只写代码里真实存在的副作用；凡是「点了不动库存 / 入库未接入」这类历史注释，随 MR 一起删掉（现存 5 处，见 P1-31）。
- [ ] 23. 每个页面的 scope 判定集中在文件顶部一处（`const can = (a) => allows(...)`），不在 JSX 里散写 `me.data?.scope.some(...)`。
- [ ] 24. 错误码 → 中文文案的映射集中一处（参考 `web/pages/companies/CompaniesPage.tsx:201-209` 的 428/409/403 分流），不各页自己编。

---

## 7. 本报告的取证基线

- 代码基线：`git log -1` = commit **`1449111`**（HEAD）；审计时工作区**存在未提交改动**（`git status --short` 列出 10 个文件，其中 7 个落在本次范围内），因此「R/S 完成」相关结论分裂成两种口径：**HEAD 是 `create`，工作区是 `approve`**（契约 `contracts/customer-returns.ts:181`、`contracts/supplier-returns.ts:120`；用例 `api/modules/sales/usecases/customer-returns.ts:348`、`api/modules/purchase/usecases/supplier-returns.ts:280`；前端 `web/pages/reversals/ReversalsPage.tsx:141-153` 新增 `canApprove`、面板 `CustomerReturnsPanel.tsx:718-732`、`SupplierReturnsPanel.tsx:610-624` 改用它）。本报告在上述所有位置**取工作区现状（`approve`）**，并把「改动未提交、无回归测试」本身记为 P0-03。
- 其余因工作区改动而需要留意口径的位置：`api/modules/sales/usecases/customer-returns.ts:102-109` 与 `api/modules/purchase/usecases/supplier-returns.ts:77-82` 的 `requireScope` 联合类型（HEAD 只有 `'read' | 'create'`）。
- 素材自身的取证范围差异：`m2`~`m4`、`m6` 按 HEAD 记录，`m5` 明确按「HEAD + 工作区」双列记录；`m1` 主数据部分不受该改动影响。

