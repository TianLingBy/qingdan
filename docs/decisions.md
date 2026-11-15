# 决策索引（docs/decisions.md）

> 本文档是全产品 `D##` 编号的索引，补齐「产品真源可定位」验收项。结论**只从代码注释、测试名、断言消息里反推**，不新增任何业务规则；业务口径与接口契约仍以 `packages/contracts` 与 `docs/api/openapi.yaml` 为准。
>
> 覆盖统计：`git grep -oE '\bD[0-9]{2,3}\b' | sort -u` 共出现 **57 个编号**（D11–D80），另含未落入该正则的单编号 D1 / D2 / D4 / D5 / D7 / D9 共 6 个。本文档已落 **63 条**，**1 条待补（需主线确认）**。
>
> 状态说明：「已落地」= 规则已存在于代码/契约并有测试覆盖；「已采纳/已冻结」= 已拍板或已冻结的架构决策；「待补（需主线确认）」= 无法从仓库反推出结论，需主线补口径。

| 编号 | 一句话结论 | 依据 | 状态 |
| --- | --- | --- | --- |
| D1 | 对外 SaaS、云端单一形态：云端是唯一记账真相，客户本地只读备份、断网只可看不可改；一期不做买断版、在线订阅计费、记账/凭证/开票；订阅到期只提示续费、不拦请求 | `docs/adr-0001-tech-stack.md:23`、`apps/api/src/modules/platform/usecases/subscription.ts:16` | 已采纳 |
| D2 | ① 库存流水只追加、正入负出；③ 结算单确认后不可冲正/取消，错账走 R 客户退货 | `apps/api/src/modules/inventory/usecases/flows.ts:83`、`apps/api/src/modules/settlement/routes.ts:28` | 已落地 |
| D4 | 「看价」是数据可见性开关而非操作权限；权限模板 = 功能域 × 8 动作（`view_price` 不进动作勾选表）；单据仅「进行中」可改；D4.1 无看价权限时金额字段回 null（保留键、不省略） | `apps/api/src/modules/sales/services/masking.ts:6`、`apps/api/src/modules/platform/usecases/positions.ts:28`、`apps/api/src/modules/masterdata/usecases/products.ts:87` | 已落地 |
| D5 | 毛利/毛利率由服务端计算并在确认时落库（净毛利 = 毛利 − 相关损失）；加工产出批次锁价；④ 提成按配置比例、负毛利记 0 | `apps/api/src/modules/settlement/routes.ts:29`、`apps/api/src/modules/settlement/repo.ts:430`、`apps/api/src/modules/processing/routes.ts:25` | 已落地 |
| D7 | 一期只做业务全流程图；实时看板、集团看板与库存预警推二期 | `apps/web/src/pages/flow/FlowPage.tsx:273`、`apps/web/src/api/query.ts:8` | 已落地 |
| D9 | 冲正单据 R（客户退货）/ S（供应商退货）/ I（盘点调整）的接口口径；本仓尚未落地，等口径确认后进 | `apps/web/src/pages/reversals/ReversalsPage.tsx:2`、`docs/members/李祖怡.md:77` | 待补（需主线确认） |
| D11 | 收款侧一期做客户在线支付「模式 A」：各企业自配商户号与密钥，平台只传指令、收回调、不碰钱；一期提成仅为报表数字、采购付款线下走 | `docs/adr-0001-tech-stack.md:373`、`packages/contracts/src/settlement-orders.ts:19` | 已采纳 |
| D12 | 订阅到期只提示续费、不拦任何请求（与 D1 同）；`dueSoon` = 30 天内到期 | `apps/api/src/modules/platform/usecases/subscription.ts:16`、`apps/api/src/modules/platform/services/entitlement.ts:7` | 已落地 |
| D13 | 手机号是一期登录账号；11 位、以 1 开头校验 | `packages/contracts/src/employees.ts:11`、`apps/api/src/platform/db/seed.ts:167` | 已落地 |
| D14 | 多租户隔离红线：所有 repo 查询必须经 `withTenant()` 注入 `tenant_id`，核心表 RLS 兜底；手机号跨租户占用 → 403 提示联系原企业管理员 | `docs/adr-0001-tech-stack.md:325`、`apps/api/src/modules/platform/usecases/employees.ts:440` | 已落地 |
| D15 | 「公司×岗位」权限、数据可见范围 = 绑定公司集合；采购单创建与修改路径都必须校验明细商品属于该单公司（`assertProductsInCompany`），数据库层再用触发器兜底 | `.github/copilot-instructions.md:12`、`docs/adr-0003-purchase-products-company-d15.md:1` | 已落地 |
| D16 | 单据号在业务事务内取号（同事务取 N / I 号），流水按「公司 + 类型 + 年月」计数、单公司月内 9999；单号格式如「E-0001-YYYYMMDD-序号」 | `apps/api/src/platform/numbering/service.ts:37`、`apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:332` | 已落地 |
| D18 | 加工单「归属单」只收 E / N 单号（选填），用于全损耗损失归属 | `packages/contracts/src/processing-orders.ts:92`、`apps/web/src/pages/processing/processing-api.ts:117` | 已落地 |
| D19 | E 单三态、C 单独立两态（待确认/已结算）；一期一单一次结算，草稿由 E/N 单「已完成」自动生成、无手工建单 | `apps/api/src/modules/settlement/routes.ts:25`、`apps/api/src/modules/sales/repo.ts:888` | 已落地 |
| D20 | 销售破成本下限审批走 platform（不另造审批表）；成本下限取批次锁价，低于下限前端只如实展示、不拦 | `apps/api/src/modules/sales/repo.ts:438`、`apps/api/src/modules/sales/routes.ts:42` | 已落地 |
| D21 | 单据取消映射为「进行中」后复用 `assertCancelable`；以 N 单为来源的库存流水存在即视为下游已发生、不可取消 | `apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:43`、`apps/api/src/modules/internal-trade/repo.ts:362` | 已落地 |
| D22 | N 单在途批次归发出方、可用量锁定；明细分批次只能引用发出公司批次；到货确认才转司解锁 | `apps/api/src/modules/internal-trade/routes.ts:27`、`apps/web/src/pages/internal-trades/InternalTradeOrdersPage.tsx:62` | 已落地 |
| D24 | E 单详情内嵌「收款记录」块；收款块余额 = 收款合计 − 退款合计（退款存负数）；应收余额 = 单头合计 − 已收款合计 | `apps/api/src/modules/sales/repo.ts:1006`、`apps/api/src/modules/payment/usecases/callback.ts:255` | 已落地 |
| D26 | 加工全损耗（可售量 = 0）需二次确认、不生成产出批次，材料与加工费全额记损失 | `packages/contracts/src/processing-orders.ts:30`、`apps/api/src/modules/settlement/routes.ts:29` | 已落地 |
| D27 | 「看价」脱敏：无对应 `view_price` 权限时金额字段返回 null（不 403、不出 0），数量照常可见 | `apps/api/src/modules/masterdata/usecases/products.ts:87`、`apps/api/src/modules/settlement/services/masking.ts:4` | 已落地 |
| D29 | C 单不提供创建端点：草稿只由来源单（E/N）「完成」时自动生成 | `apps/api/src/modules/settlement/routes.ts:27`、`apps/web/src/pages/flow/flow-map.ts:176` | 已落地 |
| D30 | 已完成/已取消单据一律不可取消，错账走冲正 R/S/I | `packages/contracts/src/documents.ts:20`、`packages/contracts/src/settlement-orders.ts:33` | 已落地 |
| D31 | N 单在途期间批次仍归发出公司；到货确认后在同一事务内转移批次归属并置 N 单已完成 | `apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:494`、`apps/web/src/pages/internal-trades/InternalTradeOrdersPage.tsx:6` | 已落地 |
| D33 | 净毛利 = 毛利 − 本单相关损失；报表层只做期间累加、不重复计算 | `apps/api/src/modules/settlement/services/profit-aggregate.ts:21`、`apps/web/src/pages/settlements/SettlementsPage.tsx:47` | 已落地 |
| D34 | E 单收款/退款只追加行（退款存负数）、历史行不更新不删除 | `apps/api/src/modules/sales/repo.ts:1038`、`apps/api/src/modules/sales/usecases/sales-receipts.ts:163` | 已落地 |
| D35 | 加工单「归属单」用于全损耗损失归集；本单相关损失按归属单聚合、结算时快照 | `apps/api/src/modules/sales/usecases/sales-orders.ts:694`、`packages/contracts/src/processing-orders.ts:92` | 已落地 |
| D36 | 提成以 C 单为单位结算；`commissionRateSnapshot` 结算时快照、改比例不重算历史单；R 客户退货冲正 | `apps/api/src/modules/settlement/routes.ts:31`、`apps/web/src/pages/settlements/SettlementsPage.tsx:47` | 已落地 |
| D37 | 已完成单的成本更正走 platform 审批（T1/T2/T3），不做独立端点 | `packages/contracts/src/purchase-orders.ts:26`、`apps/api/src/modules/purchase/routes.ts:29` | 已落地 |
| D38 | 库存批次四列（可用量/在途占用/待执行占用等）由数据库生成列维护；可用量是唯一可引用数字、不得为负 | `apps/api/src/modules/inventory/repo.ts:12`、`packages/contracts/src/inventory.ts:18` | 已落地 |
| D39 | ~~A/B 单金额与费用可为负，负数必须带备注 `note`（无备注 422）~~ **费用部分已作废（见 D83，2026-11-15）**：费用行一律不得为负；仅商品明细「金额」仍可手填覆盖 `qty × unitPrice` | `apps/api/src/modules/purchase/repo.ts:529`、`apps/api/src/modules/processing/usecases/processing-orders.ts:198` | 已落地 |
| D40 | 冲正/退款只追加负数金额行、不改历史行；退款金额必须 > 0；子类型与退款方式原样落库 | `apps/api/src/modules/sales/repo.ts:1470`、`apps/web/src/pages/flow/flow-map.ts:152` | 已落地 |
| D41 | 库存占用生命周期：提交即占用、取消释放、出库转已引用；可用量 = 入库量 − 在途占用 − 待执行占用 | `packages/contracts/src/inventory.ts:10`、`apps/web/src/pages/flow/FlowPage.tsx:322` | 已落地 |
| D42 | 已完成单成本更正走 platform 审批，审批人 = 老板/经理/财务 | `packages/contracts/src/purchase-orders.ts:27`、`packages/contracts/src/purchase-orders.ts:198` | 已落地 |
| D43 | 利润报表按「已结算 C 单毛利」期间聚合，经 D70 端口、不直读 settlement/processing 表 | `packages/contracts/src/profit-report.ts:5`、`apps/api/src/modules/settlement/services/profit-aggregate.ts:9` | 已落地 |
| D44 | 功能域清单（20 功能域 + 追加 = 24）为 scope/审计/tag/MCP 唯一键空间；权限 scope = `domain.action`；工作台与业务全流程图常显 | `packages/contracts/src/domains.ts:2`、`apps/api/src/modules/platform/usecases/positions.ts:27` | 已落地 |
| D45 | 一期不做内部定价规则表、不做利润抵消展示；实时看板/库存预警推二期 | `apps/api/src/modules/internal-trade/routes.ts:25`、`packages/contracts/src/internal-trade-orders.ts:20` | 已落地 |
| D47 | 库存流水/历史行只追加、不物理删除任何行；审批用 `version` + `status` 原子更新 | `apps/api/src/modules/inventory/services/stock-flow.ts:177`、`apps/api/src/modules/inventory/repo-stocktakes.ts:17` | 已落地 |
| D48 | 工号服务端自动发放（6 位、租户内全局唯一、入参不接收、不按月重置）；与公司编号同套单行原子自增、禁止回绕 | `apps/api/src/modules/platform/usecases/employees.ts:327`、`apps/api/src/platform/numbering/service.ts:107` | 已落地 |
| D49 | 主数据 `keyword` 检索只匹配名称/联系人/电话，不按编号（`customer_no` 等）检索 | `apps/api/src/modules/masterdata/customers-http.test.ts:15`、`apps/api/src/modules/masterdata/processors-http.test.ts:15` | 已落地 |
| D50 | 权限 = 岗位基线 ⊕ 个人覆盖 ∩ token scope；个人级权限覆盖（M1-E）不可放大 | `apps/api/src/modules/masterdata/usecases/customers.ts:79`、`apps/api/src/modules/platform/permission-overrides.test.ts:10` | 已落地 |
| D51 | 操作日志（审计）全量、只追加、不可改删、业务失败也记；审计失败阻断业务（500 告警）；① 查看敏感金额记审计 | `docs/adr-0001-tech-stack.md:378`、`apps/api/src/modules/settlement/settlement-amount-masking.test.ts:10` | 已落地 |
| D52 | API-first、OpenAPI 3.1 唯一真源、CLI + MCP 与 REST 一对一、`/api/v1` 统一约定；① 危险动作默认禁止 AI 执行 | `docs/adr-0001-tech-stack.md:378`、`apps/api/src/modules/purchase/usecases/purchase-orders.ts:40` | 已落地 |
| D52.1 | AI 权限 = 员工当前权限 ∩ token scope、每请求重算不缓存，审批只能人类；① scope 超出创建人授权直接 403；② 停用后下一请求立即 401；③ AI 不得审批自己发起的动作 | `docs/adr-0001-tech-stack.md:379`、`apps/api/src/modules/platform/usecases/api-tokens.ts:26` | 已落地 |
| D53 | 技术栈选型：TypeScript 单语言全栈（Node 24 + Fastify 5 + Drizzle + PostgreSQL + React 19/Vite + Zod 注册表发射 OpenAPI 3.1/CLI/MCP） | `docs/adr-0001-tech-stack.md:7` | 已采纳 |
| D54 | 契约缺口裁决/一期口径冻结（2026-11-04）：幂等 hash 不一致 409（原 422 已更正）、8 动作英文映射、MCP 命名 `qingdan_<domain>_<action>`、CLI 退出码映射（404/428 归 4、兜底 1）、`dryRun` 落审计 | `docs/api/cli.md:254`、`docs/adr-0001-tech-stack.md:232` | 已冻结 |
| D55 | 技术底座（U1–U5）：① 多租户共享表 + `tenant_id` + 核心表 RLS 兜底；② 金额 `numeric(18,6)`、展示四舍五入 2 位；③ UUIDv7 应用侧生成；④ Node 24 LTS + pnpm 11；⑤ 审计失败阻断业务 | `docs/adr-0001-tech-stack.md:346`、`apps/api/src/modules/platform/usecases/companies.ts:271` | 已采纳 |
| D56 | 浏览器基线：Win10 22H2 + Edge、构建目标 Chromium/Edge 111；不支持 IE11 与「兼容模式」；老机靠体积预算 | `apps/web/src/browser-baseline.ts:4`、`docs/adr-0001-tech-stack.md:330` | 已采纳 |
| D57 | spike 工程约束：① 契约注册表必须给每个实体注册 id 并重写 `$defs → components.schemas`；② PostgreSQL 主版本对齐 18；③ 应用账号非 superuser 且无 BYPASSRLS | `docs/spike-0001-tech-pipeline.md:72`、`packages/contracts/src/entities.ts:48` | 已采纳 |
| D59 | 登录/认证：③ 验证码一次性/过期/次数上限/频控；⑥ 老板 = 全功能域 × 全动作；⑧ Cookie 认证非安全请求需同源 `Origin`（CSRF） | `apps/api/src/modules/platform/auth.test.ts:11`、`apps/api/src/modules/platform/login-code.test.ts:11` | 已落地 |
| D60 | 写操作强制 `If-Match` 强 ETag，版本冲突 409 不自动重提；② `presetKey` 只接受服务端预设值或 null、不可改 | `apps/web/src/lib/write-error.ts:10`、`apps/api/src/modules/platform/usecases/companies.ts:31` | 已落地 |
| D62 | 业务模块挂载登记 + 每条路由带 `module` 归属、只从契约注册表生成；停用商品软删除（status 置停用、不物理删除） | `packages/contracts/src/routes.ts:36`、`apps/api/src/modules/index.ts:28` | 已落地 |
| D63 | 客户账期 `creditTermDays` 为整数天、≥ 0，0 = 现结，可空 = 未定 | `apps/api/src/modules/masterdata/repo-customers.ts:18`、`apps/api/src/modules/masterdata/usecases/customers.test.ts:170` | 已落地 |
| D64 | 加工厂主表只存基础资料（无价格列）；报价只增不改（无 PATCH/DELETE）、按工序 + 日期区间过滤、跨厂按单价升序比价 | `apps/api/src/modules/masterdata/processors-http.test.ts:16`、`apps/api/src/modules/masterdata/processors-http.test.ts:58` | 已落地 |
| D65 | 员工在指定公司有岗位记录（`employee_company_position` 存在）即算该公司员工 | `apps/api/src/platform/services/registry.ts:115` | 已落地 |
| D67 | 库存核心表生成列由数据库维护、流水只追加；占用明细表一期不建；成本更正不写 `inventory_flow` | `apps/api/src/modules/inventory/services/stock-flow.ts:171`、`apps/api/src/modules/inventory/repo.ts:166` | 已落地 |
| D68 | N 单独立四态（进行中/在途/已完成/已取消）；① 内部价手填、不自动算；② 仅「进行中」可改；③ 只有「在途」才真实锁定 | `apps/api/src/modules/internal-trade/routes.ts:23`、`apps/api/src/modules/internal-trade/routes.ts:25` | 已落地 |
| D69 | 结算相关损失快照冻结（`related_loss_amount_snapshot`），后续损耗变化不影响已结算单 | `apps/api/src/modules/settlement/repo.ts:18`、`apps/api/src/modules/settlement/repo.ts:429` | 已落地 |
| D70 | 跨模块只走 `registry.ts` 注册的端口，禁止直读别的模块表、禁止 import 对方 repo | `.github/copilot-instructions.md:14`、`apps/api/src/modules/inventory/services/ports.ts:10` | 已落地 |
| D71 | 盘点盘盈/盘亏拆两条发起端点、方向锁（盘亏数据发盘盈端点 422）；仓管只有「仅删减」（盘亏）、经理可审批 | `apps/api/src/modules/inventory/routes.ts:21`、`apps/api/src/modules/inventory/usecases/stocktakes.ts:295` | 已落地 |
| D72 | E 单完成 = 扣批次可用量 + 生成 C 单草稿同一事务；按行均分到所引批次、余量末批承接；③④ 损失与提成比例本期占位取 0 | `apps/api/src/modules/sales/usecases/sales-orders.ts:699`、`apps/api/src/modules/sales/usecases/sales-orders.ts:694` | 已落地 |
| D77 | 提成比例配置：① 同员工 + 公司 + 生效日唯一；② 归属人 = 来源单负责人；③ 确认时同一条 SQL 快照比例与金额 | `apps/api/src/modules/settlement/repo.ts:363`、`apps/api/src/modules/settlement/repo.ts:290` | 已落地 |
| D78 | C 单金额脱敏：无 `settlement.view_price` 权限时金额字段 null（列表/详情/确认响应一致） | `apps/api/src/modules/settlement/services/masking.ts:4`、`apps/api/src/modules/settlement/usecases/settlement-orders.ts:247` | 已落地 |
| D79 | 金额脱敏：无对应 `view_price` 权限时金额为 null（不 403、不出 0），数量照常可见；写路径返回同样脱敏 | `apps/api/src/modules/purchase/services/masking.ts:4`、`apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:282` | 已落地 |
| D80 | 提成比例配置校验：员工必须属于所选公司（走 platform 端口，不直读 `employee_company_position`） | `apps/api/src/modules/settlement/usecases/commission-rates.ts:238`、`apps/api/src/platform/services/registry.ts:106` | 已落地 |
| D81 | 单据「完成 / 确认」动作的权限点归属：完成采购单 = `purchase.update`（谁经手谁点，不再借 approve）；确认客户 / 供应商退货 = `approve`（走审批，建单仍是 `create`）；三处 summary 必须与实现一致（采购完成逐行建批次入库、退货完成按批次出入库并写库存流水） | `packages/contracts/src/purchase-orders.ts:223`、`packages/contracts/src/customer-returns.ts:181`、`packages/contracts/src/supplier-returns.ts:120`、`apps/api/src/modules/purchase/usecases/purchase-orders.ts:432`、`apps/api/src/modules/sales/usecases/customer-returns.ts:348`、`apps/api/src/modules/purchase/usecases/supplier-returns.ts:280` | 已落地 |
| D82 | 确认结算需双权限点：`settlement.approve` + `settlement.view_price`（看不到金额的人不得签结算）。读接口维持 D78 的脱敏口径（金额 null，不 403），只有「确认」这个审批动作硬校验看价；旧口径「有 approve 无 view_price 也能确认、仅响应脱敏」作废 | `apps/api/src/modules/settlement/usecases/settlement-orders.ts:296`、`apps/api/src/modules/settlement/services/masking.ts:4` | 已落地 |
| D83 | A/B/E 单「费用行」金额一律不得为负、最低 0（2026-11-15 产品口径：费用只能增加成本，不存在返利冲减；A 单旧口径「负数带备注」作废）。三处同时收紧：契约 `NonNegativeDecimal`、迁移 CHECK `purchase_order_fee_amount_non_negative`、前端正则。另：完成采购单时费用合计按明细金额占比摊入批次锁价（D5 的落地细则，见 #272） | `packages/contracts/src/purchase-orders.ts:57`、`apps/api/migrations/0032_no_negative_purchase_fee.sql`、`apps/api/src/modules/purchase/usecases/purchase-orders.ts:446` | 部分落地（非负已落地；摊入成本随 #272） |
| D84 | A 单完成建批次时把费用按明细金额占比摊入锁价：`feeTotal = SUM(费用行)`，行份额四舍五入到 6 位、末行承接余数（`SUM(share) = feeTotal`）；行金额合计为 0 时退化为按数量占比；摊后单价 = (行金额 + 份额) ÷ 数量。费用最低 0（与 D39 的负数冲减口径互斥，负数费用能力另行删除），因此摊后单价只会升不会降；D5 的成本分子 = 货款 + 费用在此落到实处。审计 `changeSummary.feeAllocation` 保留 `basis` / `feeTotal` / 每行 `{lineNo, qty, unitPrice, feeShare, adjustedUnitCost}` | `apps/api/src/modules/purchase/services/fee-allocation.ts:81`、`apps/api/src/modules/purchase/usecases/purchase-orders.ts:467`、`apps/api/src/modules/purchase/usecases/purchase-orders.ts:494` | 已落地 |
| D85 | E 单出库 = `sales.ship`，与 `sales.update` 分离：销售单没有「出货后再确认」这一步，原 `sales.order.complete`（action `update`）做的扣批次可用量 + 生成 C 单草稿就是出库本身，因此端点直接改名为 `POST /api/v1/sales-orders/{id}/ship`（operationId `sales.order.ship`），不留两个端点做同一件事。D72 的库存扣减与 C 草稿逻辑不变，只把权限点从 `sales.update` 改为 `sales.ship`：能改单不再自动能出库；审计 action、MCP 工具名、OpenAPI 路径同步改名，AI 仍默认禁止且必须给原因。依据：E 单三态只有进行中/已完成/已取消（`packages/contracts/src/documents.ts`），完成即终态，没有任何「已发货待确认」状态 | `packages/contracts/src/sales-orders.ts:261`、`apps/api/src/modules/sales/usecases/sales-orders.ts:699`、`apps/web/src/pages/sales/SalesOrdersPage.tsx:1631` | 已落地 |
| D86 | 单据「负责人 / 经手人」字段可见性走权限点 `view_handler`（按单据域 `sales` / `purchase` / `processing` / `internal_trade`），不按岗位 `preset_key` 判定；owner / manager 岗位默认授予该动作、可被撤销（2026-11-15，见 #227 / PR #229 review） | `packages/contracts/src/domains.ts:40`、`apps/api/src/platform/authz/service.ts:39`、`apps/api/src/platform/db/seed.ts:53` | 已落地 |
