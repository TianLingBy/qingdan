# 设置中心（Settings）设计方案

> 负责人 2026-11-16 需求：「功能设计上再加一个功能，设置页面，改界面，通用设置等等补齐」。
> 本文只写**能落地的东西**：每个设置项必须能指到后端端点或明确标「后端没有 → 一期不画」。
> 依据：`docs/decisions.md`（权限铁律 D4/D44）、`packages/contracts/src/*`、`apps/api/migrations/*`、《AGENTS.md》「后端说了算，现有前端不算参考」。

## 一、目标与边界

- 目标：给所有角色一个统一的**设置入口**，收拢现在散落在「公司管理 / 员工 / 权限设置 / API 与集成」里的配置项，并补上真正缺失的「通用设置」。
- 边界（一期只做这些）：
  - ✅ 新建 `/settings` 设置中心，五个分区，每个分区只渲染后端**已有**能力或本期新加的端点；
  - ✅ 公司资料补 4 个字段（地址 / 联系电话 / 税号 / LOGO 地址），可编辑；
  - ✅ 设置中心聚合只读端点（当前租户套餐与到期、公司列表与公司码、单据编号规则与当前流水、当前账号的权限点概览）；
  - ❌ 通知渠道（短信 / 微信 / 邮件）、导出模板、主题皮肤、数据字典维护、清空数据等「危险操作」——一期**不画入口**。

## 二、信息架构

路由 `/settings`，左侧五个分区，右侧内容；默认落在「通用设置」。

| 分区 | 内容 | 数据来源（后端） | 现状 |
|---|---|---|---|
| 通用设置 | 公司名称、公司码（只读）、等级、状态、地址、联系电话、税号、LOGO | `GET/PATCH /api/v1/companies/{id}`（`company.read` / `company.update`） | 端点已有；**4 个新字段本期加**（见 §三） |
| 单据编号 | 各单据类型的编号规则与当前流水值（A/B/E/N/C/R/S/I） | `GET /api/v1/settings/overview`（本期新增，只读） | 表 `number_sequence` 已有，缺只读端点 |
| 账号安全 | 当前登录手机号（脱敏）、所属公司与岗位、API 令牌入口（跳转 `/api-integration`） | `GET /api/v1/settings/overview`（同上的 `me` 段） | 数据都在，缺聚合端点 |
| 权限概览 | 我在当前公司被授予的 `domain.action` 列表（只读，不可改，改权限去 `/permissions`） | 同上（`permissions` 段） | 数据来自 `allowsScope`，缺只读端点 |
| 订阅与套餐 | 套餐名、到期日、状态（只读）；续费按钮**不画**（无后端） | 同上（`tenant` 段） | `tenant.plan/expires_at/status` 已有 |

**为什么用「一个聚合只读端点」而不是五个小端点**：五个分区都是同一租户、同一请求上下文，一次查完再分发，前端少四次 RTT，后端少四套鉴权与审计样板，符合代码约定里的「不重复造轮子 + 复杂度低」。

## 三、一期改动清单

### 3.1 后端（含红线，只给主线）

1. **迁移** `20261116HHMMSS_company_profile_fields.sql`（时间戳前缀，见 `DISPATCH-RULES.md` §十二）：
   `ALTER TABLE company ADD COLUMN address text, ADD COLUMN contact_phone text, ADD COLUMN tax_no text, ADD COLUMN logo_url text;`
   全部可空、无默认值 —— 老数据不动，不做 backfill；`contact_phone` 加 `CHECK (contact_phone ~ '^[0-9+\-]{7,20}$')`，`logo_url` 加 `CHECK (logo_url ~ '^https?://')`。
2. **契约** `packages/contracts/src/companies.ts`：`CompanySchema` 加 4 个可空字段，`UpdateCompanyInput` 同名可选；`GET /api/v1/companies/{id}` 已存在则不动签名。
3. **新端点** `GET /api/v1/settings/overview`（`packages/contracts/src/settings.ts`）：`domain: 'company'`、`action: 'read'`、`audit: { kind: 'none' }`，返回 `{ tenant, companies[], numbering[], me: { phoneMasked, companies[], positions[] }, permissions[] }`。
   权限点复用 `company.read`（不新增 domain —— 新增域要改 `domains.ts` 与 `decisions.md`，成本远大于收益，见 §五）。
4. **用例** `apps/api/src/modules/platform/usecases/settings-overview.ts`：一次取租户 + 公司列表 + `number_sequence` 当前值 + 当前 principal 的授权点；脱敏手机号 `138****1234`。
5. **测试**：`settings-overview-http.test.ts`（无 `company.read` 的用户 403；有 `view_price` 与否不影响本端点；手机号必须脱敏）、`companies-profile-http.test.ts`（4 字段 PATCH 往返、`tax_no` 非法值 422、`If-Match` 版本冲突 409）。

### 3.2 前端（前端池）

1. `apps/web/src/pages/settings/SettingsPage.tsx`：五个分区（左侧 tab + 右侧面板），数据全部来自 `settings/overview`，无数据时给统一空状态。
2. `GeneralSettingsPanel.tsx`：公司选择器（多公司时）+ 4 个新字段表单；写路径走 `PATCH /api/v1/companies/{id}`，带 `If-Match`（D60），冲突提示按 `apps/web/src/lib/write-error.ts` 的既有口径。
3. 只读分区（编号 / 账号 / 权限概览 / 套餐）直接渲染，不做编辑入口；无权限时按 `access.ts` 的既有三态显示「无权限」而不是空白。
4. 注册路由 `apps/web/src/router/routes.ts` 增加 `{ id: 'settings', path: '/settings', page: '设置中心', domain: '系统', title: '设置中心' }`，并纳入导航分组（见 §四）。

### 3.3 界面改版（前端池，与设置中心同批）

- 侧边栏按 `routes.ts` 的 `domain` 分组折叠（公共 / 单据与结算 / 冲正 / 主数据 / 库存 / 组织 / 报表 / 系统），默认展开当前所在组。
- 「设置中心」放「系统」组首位；`/companies`、`/permissions`、`/employees`、`/api-integration` 保留原路由不变，避免打断已开的单据页工作。
- 统一表格空状态、加载态、错误态三件套（现在各页各写一套）。

## 四、权限与审计口径

- 读概览：`company.read`；编辑公司资料：`company.update`（写操作审计 `company.company.update`，走既有 `audit: { kind: 'write' }`）。
- **不用职位判断**：前端只按 `allowsScope` 决定按钮可不可点，后端 `requireScope` 兜底（AGENTS.md 铁律）。
- 手机号、`tax_no` 属敏感字段：概览端点对无 `company.read` 者直接 403，对有权限者手机号仍脱敏（只回 `138****1234`）。

## 五、为什么一期不新增 `settings` 功能域

新增 domain 要同时改 `packages/contracts/src/domains.ts`、`docs/decisions.md`，并让权限设置页、审计 tag、MCP 工具名全部跟进；而本期所有设置项本来就有归属域（公司资料 → `company`，编号 → `company`/各单据域，账号 → `employee`，令牌 → `api_integration`）。用归属域的权限点表达，语义更准确，也符合「一个动作只对应一件事」。

二期若真的要「租户级参数」（比如开关式配置、通知渠道），再单独立 `settings` 域并走红线评审。

## 六、验收命令

```powershell
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests/run.ps1
node tools/check-numbering.mjs --base origin/main   # 迁移号必须 [ok]
```

前端额外：`pnpm -C apps/web build`，并在浏览器里走一遍 `/settings` 五个分区 + 无权限账号的三态。

## 七、明确不做（一期）

- 通知渠道配置、消息模板、导出模板、主题皮肤（无后端表，画了就是假功能）；
- 数据字典 / 枚举维护（枚举是契约里的 `as const`，改要发版）；
- 清空数据、重置租户、删除公司等危险操作入口；
- 续费 / 支付结算（`billing` 域未落地）。

## 八、待负责人拍板

1. **4 个新字段够不够**：地址 / 联系电话 / 税号 / LOGO 地址。要不要再加「开票抬头」「银行账户」「公司简称」？
2. **设置中心要不要独立一级域名**：本文建议复用 `company.read/update`；若你希望「设置」成为独立权限点（可单独授权给某人、不影响公司管理），我就改成新增 `settings` 域（动 `domains.ts` + `decisions.md`，红线评审）。
3. **界面改版范围**：只做侧边栏分组 + 五分区页面，还是同时把现有单据页的表格/空状态一起统一？（后者工量大，建议单独立 issue 排期。）
