# 设置中心（Settings）设计方案

> 负责人 2026-11-16 需求：「功能设计上再加一个功能，设置页面，改界面，通用设置等等补齐」，随后补充：「可以结合其他软件上网搜索，一个设置页面都会有什么功能，什么修改头像啊，真实姓名啊，更换手机号，页面颜色，查看已有权限，用户协议等等」。
>
> 本文只写**能落地的东西**：每一项都标注后端有没有能力、本期做不做、做不到的写清原因。
> 依据：`docs/decisions.md`（权限铁律 D4/D44/D50）、`packages/contracts/src/*`、`apps/api/migrations/*`、《AGENTS.md》「后端说了算，现有前端不算参考」。

## 一、目标与边界

- 目标：一个统一的 `/settings` 设置中心，覆盖**个人账号**与**公司/系统**两类设置，把现在散落在「公司管理 / 员工 / 权限设置 / API 与集成」的配置收拢进来，并补上真正缺的个人设置与外观设置。
- 边界：只画后端有能力的；后端没有的一律列为二期并写明缺什么，不画假按钮。

## 二、功能总表（对标常见软件设置页，逐项标后端有无）

参考对象：SaaS 后台（Recruitee/Tellent 统一设置中心、VerifyWise 组织设置）、开发者平台（GitHub、Flare 的 Profile→Account 分区）、协作工具（BuddyNext 账号/通知/隐私/外观四页）、电商卖家后台（橙联个人中心）。共同规律：**分成「个人」与「组织」两层**，个人层永远是「资料 / 安全 / 通知 / 外观 / 隐私」，组织层是「资料 / 成员 / 权限 / 集成 / 计费 / 日志」；危险操作固定收在页面最底部的独立区域（[Recruitee 统一设置](https://support.recruitee.com/fr/articles/12819873-naviguer-dans-les-parametres-unifies-de-tellent)、[VerifyWise 设置说明](https://github.com/verifywise-ai/verifywise/blob/23e4e3fa13142481132a9de1b0ab4c0e11256fae/Clients/src/presentation/helpers/settings-help.html)、[Flare 账号文档](https://github.com/flintsh/flare/blob/1e9e44ea5e4be9d41b271fdb7af6957f6ac0cbd7/docs/site/guide/account.md)）。

### A. 个人账号

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| A1 | 头像 | ❌ 无对象存储、`employee` 表无 `avatar` 列 | 一期降级 | 一期用**姓名首字色块**占位；二期加 `avatar_url` 列 + 上传能力 |
| A2 | 显示名 / 真实姓名 | ✅ `employee.name` 已有；❌ 缺「只改自己」的端点 | 一期做 | 新端点 `PATCH /api/v1/employees/me`，权限 `employee.update`（仅本人，管理员改别人走 `/employees`） |
| A3 | 更换手机号（登录账号） | 🟡 `employee.phone` 唯一且是登录账号；短信通道已有（`apps/api/src/platform/sms/tencent.ts`，登录码走一次性码表） | 一期做 | 流程：新号收码校验 → 旧号确认码（或管理员审批）→ 改号并**吊销全部会话**；审计必留 |
| A4 | 修改密码 | ❌ 本项目验证码登录，无密码 | 不做 | 不画入口 |
| A5 | 二次验证 / 2FA | ❌ 无 | 二期 | 需要 TOTP 秘钥列 + 恢复码 |
| A6 | 登录设备与会话 | ✅ `session` 表有 `ip`/`user_agent`/`issued_at`/`last_seen_at`/`revoked_at` | 一期做 | 只读列表 + 「踢下线」（写 `revoked_at`），需新端点 |
| A7 | 注销账号 | 🟡 员工停用由管理员操作（`employee.status`） | 一期只读 | 个人页给说明并跳 `/employees`，不提供自助注销（业务数据关联复杂） |

### B. 公司 / 组织

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| B1 | 公司资料（名称/公司码/等级/状态） | ✅ `company` 表已有，`company.read/update` | 一期做 | 公司码只读（D16 服务端发放） |
| B2 | 公司扩展资料（地址/联系电话/税号/LOGO） | ❌ 表里没有 | 一期做 | 时间戳迁移加 4 列，全可空不 backfill |
| B3 | 开票抬头 / 银行账户 | ❌ 无 | 二期 | 涉及财务口径，先定字段归属再建表 |
| B4 | 成员与岗位（入口） | ✅ `/employees` 已有 | 一期做 | 设置中心只放入口，不重复实现 |
| B5 | 我的权限（只读查看） | 🟡 数据在 `position_permission` + `employee_permission_override`，缺只读端点 | 一期做 | 显示 `domain.action` 列表 + 来源（岗位/个人增减） |
| B6 | 权限设置（管理员入口） | ✅ `/permissions` 已有 | 一期做 | 设置中心放入口 |

### C. 外观与体验

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| C1 | 主题色 / 浅色深色 | ✅ 不需要后端 | 一期做 | 存 `localStorage`，跟随系统默认可关闭；不落库避免跨设备脏数据 |
| C2 | 表格密度（紧凑/舒适） | ✅ 不需要后端 | 一期做 | 存 `localStorage`，`apps/web/src/components/**` 提供密度容器 |
| C3 | 侧边栏折叠 / 默认落地页 | ✅ 不需要后端 | 一期做 | 存 `localStorage` |
| C4 | 语言 / 时区 / 日期格式 | ❌ 无 i18n，日期格式全站固定 | 不做 | 只读展示「简体中文 / GMT+8 / YYYY-MM-DD」，不画选择器 |
| C5 | 字号缩放 | ✅ 不需要后端 | 二期 | 与 C2 合并做更省事 |

### D. 通知（全不做，无后端）

| # | 功能 | 现状 | 本期 |
|---|---|---|---|
| D1 | 通知渠道（短信 / 站内 / 微信） | ❌ 无 `notification_preference` 表、无站内信 | 二期 |
| D2 | 提醒开关（待办 / 审批 / 库存预警） | ❌ 无 | 二期 |

### E. 业务偏好

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| E1 | 单据编号规则与当前流水（只读） | ✅ `number_sequence` 已有 | 一期做 | 展示 A/B/E/N/C/R/S/I 规则（D16/D48）与当前值 |
| E2 | 编号规则自定义 | ❌ D16 固定格式 | 不做 | 改格式会让历史单号不可解析 |
| E3 | 默认公司 / 默认仓库 / 默认结算方式 | ❌ 无偏好表 | 二期 | 与 D1 合并成 `employee_preference` 表 |
| E4 | 打印模板 / 导出模板 | ❌ 无 | 二期 | |

### F. 数据与安全

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| F1 | API 令牌（入口 + 现有令牌管理） | ✅ `api_token` 表 + `/api-integration` | 一期做 | 设置中心放入口 |
| F2 | 操作日志（我的操作） | ✅ `audit_log` 已有 | 一期做 | 入口跳 `/audit-logs`，筛自己的记录 |
| F3 | 数据导出（导出我的数据） | 🟡 有 `export` 动作，但无「导出我的账号数据」端点 | 二期 | |
| F4 | 危险区域（清空数据 / 重置租户 / 删除公司） | ❌ 无且不该有入口 | 不做 | 只留一句「无自助危险操作，请联系负责人」 |

### G. 订阅与计费

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| G1 | 套餐 / 到期日 / 状态（只读） | ✅ `tenant.plan/expires_at/status` | 一期做 | 到期只提示不中断（D1/D12） |
| G2 | 续费 / 发票 / 账单历史 | ❌ `billing` 域未落地 | 不做 | 不画按钮 |

### H. 关于与合规

| # | 功能 | 后端现状 | 本期 | 说明 |
|---|---|---|---|---|
| H1 | 用户协议 / 隐私政策 | 🟡 无现成文本 | 一期做 | 静态 markdown 页（`/legal/terms`、`/legal/privacy`），文本由负责人定稿，先放占位骨架 + 「待法务确认」 |
| H2 | 版本号 / 更新日志 | ✅ 前端读 `package.json` 版本 | 一期做 | 只读展示 |
| H3 | 帮助 / 联系负责人 | ✅ 联系方式由负责人给 | 一期做 | 只读 |

### I. 贴合现有功能新增的有用项（都是「后端已有、只差入口或只读展示」）

这一组是本次补充的重点：**不新增表、不新增域**，只是把已经存在的能力收进设置中心，或者用纯前端实现。

| # | 功能 | 后端依据 | 本期 | 价值 |
|---|---|---|---|---|
| I1 | API 令牌自助创建 / 轮换 / 吊销 | ✅ `platform.token.create` / `.read` / `.revoke` 端点已在契约里 | 一期做 | 现在只能用管理员开的令牌；本人可自助，减少一条人工流程 |
| I2 | 下一个单号预览（每种单据类型显示「下一个号」） | ✅ `number_sequence` 表已有当前值 | 一期做 | 录入前就知道会拿到哪个号，撞号/断号一眼可见 |
| I3 | 我的公司范围与岗位（只读列表） | ✅ `employee_company_position` + `position` | 一期做 | 常见疑问「我能看哪几家公司」自助解答 |
| I4 | 审计日志「只看我的」（带条件直达 `/audit-logs`） | ✅ `audit_log` 有 `operator_id` | 一期做 | 免去每次进页面再手填筛选 |
| I5 | 提成率只读展示 | ✅ `commission_rate` 表；权限 `view_price` | 一期做 | 提成规则透明度；无 `view_price` 则整块隐藏（不显示 0） |
| I6 | 岗位预设说明（老板/财务/仓管/开发者 各自默认带哪些 scope） | ✅ `position.preset_key` + `position_permission` | 一期做 | 解决「为什么他能改我不能」，避免误以为写死了角色 |
| I7 | 系统状态（服务是否可用 + 版本 + 构建时间） | ✅ `GET /api/v1/health` 已存在 | 一期做 | 出问题先自证是不是服务挂了，减少一次询问 |
| I8 | 命令面板（Ctrl+K 全局跳转页面/单据） | ✅ 纯前端，路由表已有 | 一期做 | 页面已 22 个，跳转比找菜单快；不涉及后端 |
| I9 | 常用页面置顶 / 收藏 | ✅ 纯前端 `localStorage` | 一期做 | 每人常去的就那三四页 |
| I10 | 术语与权限词表（域×动作的中文对照，只读） | ✅ 直接读 `packages/contracts/src/domains.ts` 的 `DOMAINS`/`ACTIONS` | 一期做 | 权限页里的「internal_trade.ship」有处可查，不用问人 |

**为什么这些算「有用」而不是堆功能**：I1/I2/I4/I7 各自省掉一次「找人问」；I3/I5/I6 直接回答权限与提成的常见疑问；I8/I9/I10 是纯前端零风险，且立刻降低 22 个页面的导航成本。

### 二期候选（等 `employee_preference` 表，一次做完）

默认公司、默认单据类型、常用商品/客户置顶、列表列宽与排序记忆、通知偏好、导出我的数据、打印模板、头像上传、2FA。这些都需要落库，攒到一张偏好表一起做，比现在一项一项加表省得多。

## 三、信息架构（两段式）

`/settings` 左侧分两段，默认落在「我的资料」。

```
个人设置                     公司设置（按权限显示，无公司权限整段隐藏）
├─ 我的资料 A1 A2             ├─ 公司资料 B1 B2
├─ 账号安全 A3 A6 A7          ├─ 成员与岗位 B4 B6 I3 I6
├─ 我的权限 B5 I10            ├─ 单据编号与提成 E1 I2 I5
├─ 外观 C1 C2 C3              ├─ API 与集成 F1 I1
├─ 通知（二期占位，不画）      ├─ 订阅与套餐 G1
├─ 关于 H1 H2 H3 I7           └─ 安全与日志 F2 F4 I4
└─ 工具 I8 I9（命令面板与收藏，入口固定在右上角）
```

## 四、一期改动清单

### 4.1 后端（含红线，只给主线）

1. **迁移** `20261116HHMMSS_settings_center_fields.sql`（时间戳前缀，见 `DISPATCH-RULES.md` §十二）：
   - `ALTER TABLE company ADD COLUMN address text, ADD COLUMN contact_phone text, ADD COLUMN tax_no text, ADD COLUMN logo_url text;`（全可空、无默认、不 backfill；`contact_phone` CHECK `^[0-9+\-]{7,20}$`，`logo_url` CHECK `^https?://`）
   - 换手机号需要「待验证新号」暂存：`ALTER TABLE employee ADD COLUMN pending_phone text, ADD COLUMN pending_phone_code_hash text, ADD COLUMN pending_phone_expires_at timestamptz;`
2. **契约**：`packages/contracts/src/companies.ts`（4 字段）、`packages/contracts/src/settings.ts`（新建，以下四个端点）。
3. **端点**（全部挂 `platform` 模块）：
   | operationId | 方法与路径 | 权限 | 审计 |
   |---|---|---|---|
   | `platform.settings.overview` | `GET /api/v1/settings/overview` | `company.read` | none |
   | `platform.settings.updateProfile` | `PATCH /api/v1/employees/me` | `employee.update`（仅本人） | write |
   | `platform.settings.requestPhoneChange` | `POST /api/v1/employees/me/phone/request` | `employee.update`（仅本人） | write |
   | `platform.settings.confirmPhoneChange` | `POST /api/v1/employees/me/phone/confirm` | `employee.update`（仅本人） | write |
   | `platform.settings.sessions` | `GET /api/v1/employees/me/sessions` | `employee.read`（仅本人） | none |
   | `platform.settings.revokeSession` | `DELETE /api/v1/employees/me/sessions/{id}` | `employee.update`（仅本人） | write |
   概览返回 `{ tenant, companies[], numbering[], me: { name, phoneMasked, companies[], positions[] }, permissions[], sessions[] }`。
4. **用例**：`settings-overview.ts`、`settings-profile.ts`、`settings-phone.ts`（复码 60 秒限流 + 当日上限，复用 `send-code.ts` 的既有策略与错误码 `RATE_LIMITED`）、`settings-sessions.ts`。
5. **测试**：无权限 403；概览手机号脱敏 `138****1234`；改号只成功一次（旧码失效）、成功后旧会话全部 `revoked_at` 非空；踢下线后该 token 立即 401；`PATCH /employees/me` 只能改自己（改别人 id 必须 403）。

### 4.2 前端（前端池）

1. `apps/web/src/pages/settings/SettingsPage.tsx`：两段式左栏（个人 / 公司），公司段按 `allowsScope` 决定是否显示。
2. 面板：`MyProfilePanel`（A1 首字色块 + A2）、`AccountSecurityPanel`（A3 换号三步 + A6 会话列表与踢下线 + A7 说明）、`MyPermissionsPanel`（B5 + I10 词表对照）、`AppearancePanel`（C1/C2/C3）、`CompanyProfilePanel`（B1 可编辑 + B2 四字段）、`BusinessParamsPanel`（E1 规则 + I2 下一个号 + I5 提成率，无 `view_price` 则隐藏提成块）、`MembersPanel`（B4/B6 入口 + I3 我的范围 + I6 预设说明）、`TokenPanel`（F1/I1 自助令牌）、`SubscriptionPanel`（G1 只读）、`AboutPanel`（H1/H2/H3 + I7 系统状态）、`SecurityLogPanel`（F2/F4 入口 + I4 直达筛选）。
3. 全局工具：`apps/web/src/components/CommandPalette.tsx`（I8，`Ctrl+K` 打开，路由表驱动，键盘可达）、`apps/web/src/lib/pins.ts`（I9 常用页置顶，`localStorage`）。
4. 外观设置落 `apps/web/src/lib/preferences.ts`（`localStorage`，键名前缀 `qingdan.`），CSS 变量切换主题色。
4. 路由 `apps/web/src/router/routes.ts` 加 `{ id: 'settings', path: '/settings', page: '设置中心', domain: '系统', title: '设置中心' }`，并注册 `/legal/terms`、`/legal/privacy`。
5. 统一空/加载/错误三态（与导航改版同批）。
6. **所有分区、字段、按钮的显隐都必须走 §五 矩阵**，不得用角色名判断；每个分区配一条测试：「无该 scope 时不渲染」+「有该 scope 时可操作」。

### 4.3 界面改版（前端池，components 归何永上）

- 侧边栏按 `routes.ts` 的 `domain` 分组折叠，默认展开当前组；「设置中心」放「系统」组首位。
- `/companies`、`/permissions`、`/employees`、`/api-integration` 路由不变，避免打断已开单据页工作。

## 五、按权限显隐：三态矩阵（本设计的核心约束）

原则一句话：**能不能看由一个 `domain.action` 决定，能不能改由另一个动作决定；没权限就整块不渲染，不做「灰着但能点」。**

### 5.1 为什么个人设置不需要业务 scope

「改我自己的名字 / 换我自己的手机号 / 踢掉我自己的会话」这类操作，服务端判的是 `principal.employeeId === target.employeeId`（本人即授权），**不要求 `employee.update`**——否则普通员工连自己名字都改不了。但：

- 端点路径固定为 `/employees/me/**`，**不接受 body/query 里传别人的 id**；管理改别人只能走 `/employees/{id}` 且必须有 `employee.update`；
- 每项本人操作仍写审计（`employee.employee.update` 等），只是不要求业务 scope；
- 前端不得自己判断「我是本人」，一律以接口返回为准（概览里回 `me` 段就代表你是谁）。

### 5.2 分区级矩阵

| 分区 | 可见条件（任一满足） | 可编辑条件 | 无权限时表现 |
|---|---|---|---|
| 我的资料 | 登录即可（本人） | 本人；显示名/姓名走 `/me` | —（总有） |
| 账号安全（换号 / 会话） | 登录即可（本人） | 同上；踢会话同样只限本人 | 「会话」列表为空时给「暂无其他设备」 |
| 我的权限 | 登录即可（本人） | 永远只读 | —（总有） |
| 外观 / 工具 / 关于 | 登录即可 | 本地偏好，无需后端 | —（总有） |
| 公司资料 B1 | `company.read` | `company.update` | 只读展示，隐藏「保存」 |
| 公司资料 B2（4 字段） | `company.read` | `company.update` | 同上 |
| 成员与岗位 B4/B6 | `employee.read`（成员）/ `permission.read`（权限页入口） | 跳转页内自有判断 | 该入口不渲染 |
| 我的公司范围 I3 | `employee.read` | 只读 | 不渲染 |
| 岗位预设说明 I6 | `permission.read` | 只读 | 不渲染 |
| 单据编号 E1 / 下一个号 I2 | `company.read` | 永远只读 | 不渲染 |
| 提成率 I5 | `settlement.read` **且** `view_price` | 只读 | **整块隐藏**（不显示 0、不显示「无权限」） |
| API 与集成 F1 | `api_integration.read` | 创建 `api_integration.create`；吊销 `api_integration.delete` | 只读列表，隐藏「新建/吊销」 |
| 订阅与套餐 G1 | `billing.read` | 只读（续费不做） | 不渲染 |
| 安全与日志 F2/I4 | `audit.read` | 只读 | 不渲染 |
| **公司设置整段** | 上面任一公司类 scope 成立 | — | 左栏「公司设置」整段隐藏，只剩个人设置 |

### 5.3 实现规则（防「隐藏了但能打」）

1. **隐藏 ≠ 禁用 ≠ 授权**：前端隐藏只影响观感，每个端点仍 `requireScope` 兜底；写一条测试证明「不给 scope 直接调接口得 403」，与「前端不渲染」成对存在。
2. **不要返回空数组假装没权限**：概览端点对无 `company.read` 者返回 **403**（`FORBIDDEN`），而不是 `companies: []`——否则前端会把「没权限」显示成「没有公司」。
3. **同一页面内混合权限**：能看不能改时，表单字段 `readOnly` + 隐藏保存按钮 + 顶部一句「你只有查看权限（需要 `company.update`）」，把缺哪个权限点直接写出来，省一次询问。
4. **多公司**：概览只返回 `principal` 有权访问的公司（`employee_company_position` 交集），前端不自己筛；公司选择器默认本人主公司，切换后重新拉概览。
5. **审计与脱敏**：概览只回脱敏手机号 `138****1234`；`tax_no` 对无 `company.read` 者不可见；改号审计记旧号掩码 + 新号掩码 + 操作人，不落明文。
6. **不用职位判断**：代码里不出现 `role === 'owner'`、`isManager`；只出现 `allowsScope(principal, 'company.update')`。岗位预设只是默认 scope 集合（见 I6 说明页）。

## 六、为什么不新增 `settings` 功能域（一期）

每项都有归属域：公司资料 → `company`，个人资料/会话 → `employee`，编号 → `company`，令牌 → `api_integration`，日志 → `audit`。用归属域权限点语义更准，也避免改 `domains.ts` + `decisions.md`（红线）。二期若出现「租户级开关参数」，再单独立 `settings` 域走评审。

## 七、验收命令

```powershell
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests/run.ps1
node tools/check-numbering.mjs --base origin/main   # 迁移号必须 [ok]
```

前端额外：`pnpm -C apps/web build`；浏览器走一遍九个分区 + 无权限账号（公司段整段隐藏）+ 换号流程 + 主题色刷新后保持。

## 八、明确不做（一期）及原因

| 项 | 原因 |
|---|---|
| 头像上传 A1 | 无对象存储与上传链路；先首字色块，二期补 `avatar_url` + 上传 |
| 密码 / 2FA A4 A5 | 本系统验证码登录，无密码体系；2FA 需 TOTP 秘钥与恢复码，二期 |
| 自助注销 A7 | 员工与业务数据强关联，停用走管理员；个人页只给说明 |
| 开票/银行 B3 | 财务口径未定 |
| 通知偏好 D1 D2 | 无 `notification_preference` 表、无站内信通道 |
| 编号自定义 E2 | D16 固定格式，改格式历史单号不可解析 |
| 默认公司/仓库、打印导出模板 E3 E4 | 无偏好表，二期与 D1 合并成 `employee_preference` |
| 导出我的数据 F3 | 无对应端点 |
| 危险操作 F4 | 不提供自助危险入口 |
| 续费/发票 G2 | `billing` 域未落地 |
| 语言/时区 C4 | 无 i18n；只读展示固定值 |

## 九、待负责人拍板

1. **公司扩展字段**：地址 / 联系电话 / 税号 / LOGO 地址是否够用？要不要加「公司简称」「开票抬头」（B3 提前到一期）？
2. **换手机号审批**：建议「新号收码 + 旧号收码」双确认（不需要管理员）；若你要求管理员审批，我就加审批态。
3. **用户协议 / 隐私政策文本**：一期先放占位骨架标「待法务确认」，还是你直接给我定稿文本？
4. **主题色范围**：只做「浅色/深色 + 主色 N 选 1」，还是要完整主题编辑器？（后者工量翻倍）
5. **I 组十项要不要全做**：我的建议是**全做**——I1/I2/I4/I7 各自省一次「找人问」，I8/I9/I10 纯前端零风险；只有 I5 提成率需要你确认「让谁知道提成率」（我默认：有 `view_price` 才显示）。如果嫌多，优先留 I1 令牌自助、I7 系统状态、I8 命令面板这三项。
