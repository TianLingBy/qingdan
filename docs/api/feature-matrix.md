# 后端功能表（给前端）

> 由 `node tools/gen-feature-matrix.mjs` 从接口真源重生成（`packages/contracts/openapi.json`，
> 与 `docs/api/openapi.yaml` 同源，CI `spec-drift` 保证不漂移）。不要手改本文件，改 spec 再重生成。
>
> 三条约定：
> 1. **权限**列就是后端 `requireScope` 的动作，前端按钮的「能不能点」照它判：`allows(scope, 域, 动作)`；
>    `read_all` 只影响列表「看谁的」，不改变单个动作能不能做。
> 2. **If-Match** 为「是」的写端点必须带乐观锁 `If-Match: <etag>`（取自上一次 GET 的响应头），不带会被 412 拒。
> 3. 无 `view_price` 权限时后端把金额字段置 `null`，前端显示「—」，不要当 0。

## 总览

- 端点合计 **152** 个，分布在 **24** 个域。
- 前端源码里已出现 **128** 个；
  **22** 个后端已就绪但前端没接（见文末清单）。

## API 对接（`api_integration`，5 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/health` | `api_integration.read` | — | **未接** | 健康检查（不认证、不记审计） |
| GET | `/openapi.json` | `api_integration.read` | — | ✓ | OpenAPI 3.1 文档（接口真源，公开只读） |
| POST | `/api-tokens` | `api_integration.create` | — | ✓ | 创建 API Token（scope ⊆ 创建人授权，超出拒绝） |
| GET | `/api-tokens` | `api_integration.read` | — | ✓ | Token 列表（敏感读，必记审计） |
| DELETE | `/api-tokens/{id}` | `api_integration.delete` | 是 | ✓ | 撤销 Token（危险动作，AI 默认禁止） |

## 员工与登录（`employee`，13 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/auth/code` | `employee.read` | — | ✓ | 发送登录验证码（同号 60 秒一条、每天最多 10 条） |
| POST | `/auth/login` | `employee.read` | — | ✓ | 手机号 + 验证码登录（验证码由 /auth/code 下发，非生产固定码直通） |
| POST | `/auth/logout` | `employee.read` | — | ✓ | 登出（只失效当前会话） |
| GET | `/auth/me` | `employee.read` | — | ✓ | 当前登录主体与生效权限 |
| GET | `/employees` | `employee.read` | — | ✓ | 员工列表（普通读不记审计；老板见全租户，非老板仅绑定公司集合） |
| POST | `/employees` | `employee.create` | — | ✓ | 创建员工（工号由服务端按 D48 自动发放；建账号属危险动作，AI 默认禁止） |
| PATCH | `/employees/{id}` | `employee.update` | 是 | ✓ | 修改员工（强 ETag If-Match；不可改 id / 工号；改 isOwner 仅限人类） |
| DELETE | `/employees/{id}` | `employee.delete` | 是 | ✓ | 停用员工（软删除，不做物理删除；危险动作，AI 默认禁止） |
| PATCH | `/employees/me` | `employee.update` | 是 | ✓ | 保存我的资料（只改本人；name 免业务 scope，公司四字段需 company.update） |
| POST | `/employees/me/phone/request` | `employee.update` | — | **未接** | 申请换手机号（向新号发 6 位码；同号 60 秒一条、24 小时最多 10 条） |
| POST | `/employees/me/phone/confirm` | `employee.update` | — | **未接** | 确认换手机号（码一次性；成功后改手机号并吊销本人全部会话） |
| GET | `/employees/me/sessions` | `employee.read` | — | ✓ | 我的登录会话（只回设备标识与时间，不回 token / UA 原文） |
| DELETE | `/employees/me/sessions/{id}` | `employee.update` | — | ✓ | 踢掉我的一条会话（只限本人；id 不属于本人 → 403） |

## 权限与岗位（`permission`，5 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/positions` | `permission.read` | — | ✓ | 岗位列表（分页；可按 presetKey 过滤，普通读不记审计） |
| POST | `/positions` | `permission.create` | — | ✓ | 新建岗位（权限模板；presetKey 仅限服务端预设值或 null；AI 默认禁止） |
| PATCH | `/positions/{id}` | `permission.update` | 是 | ✓ | 修改岗位权限模板（强 ETag If-Match；不可改 presetKey；AI 默认禁止） |
| DELETE | `/positions/{id}` | `permission.delete` | 是 | ✓ | 停用岗位（软删除；被员工占用的岗位不允许删；危险动作，AI 默认禁止） |
| PATCH | `/employees/{employeeId}/permissions` | `permission.update` | — | ✓ | 员工个人级权限覆盖（D50；经理不可改老板/财务/其他经理） |

## 公司（`company`，4 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/companies` | `company.read` | — | ✓ | 公司列表（分页；普通读不记审计） |
| POST | `/companies` | `company.create` | — | ✓ | 新建公司（公司码由服务端按 D16 自动发放；AI 默认禁止） |
| PATCH | `/companies/{id}` | `company.update` | 是 | ✓ | 修改公司名称（强 ETag If-Match；不可改公司码） |
| GET | `/settings/overview` | `company.read` | — | ✓ | 设置中心概览（无 company.read → 403；手机号脱敏；只返回可访问公司） |

## 操作日志（`audit`，1 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/audit-logs` | `audit.read` | — | ✓ | 操作日志查询（敏感读，必记审计；保留 180 天在线） |

## 商品（`product`，6 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/products` | `product.read` | — | ✓ | 商品列表（按名称/别名检索；普通读不记审计，D49 不按编号全局搜） |
| POST | `/products` | `product.create` | — | ✓ | 新增商品（编号自由文本可空；默认售价受看价权限管，D4.1/D49） |
| GET | `/products/suggest` | `product.read` | — | ✓ | 建档防重：按名称提示已有相似商品（只回 id/名称/相似度，D99） |
| GET | `/products/{id}` | `product.read` | — | ✓ | 商品详情（无看价权限时默认售价返回 null，D27） |
| PATCH | `/products/{id}` | `product.update` | 是 | ✓ | 修改商品（强 ETag If-Match；改默认售价需看价权限） |
| DELETE | `/products/{id}` | `product.delete` | 是 | ✓ | 删除商品（物理删除；被单据引用时 409 拒绝，危险动作，AI 默认禁止） |

## 客户（`customer`，15 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/customers` | `customer.read` | — | ✓ | 客户列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜） |
| POST | `/customers` | `customer.create` | — | ✓ | 新增客户（编号自由文本可空；客户无金额字段，D49） |
| GET | `/customers/suggest` | `customer.read` | — | ✓ | 建档防重：按名称提示已有相似客户（只回 id/名称/相似度，D99） |
| GET | `/customers/{id}` | `customer.read` | — | ✓ | 客户详情（D15 跨公司不可见） |
| PATCH | `/customers/{id}` | `customer.update` | 是 | ✓ | 修改客户（强 ETag If-Match） |
| DELETE | `/customers/{id}` | `customer.delete` | 是 | ✓ | 删除客户（物理删除；被单据引用时 409 拒绝，危险动作，AI 默认禁止） |
| GET | `/customers/{id}/contacts` | `customer.read` | — | **未接** | 客户对接人列表（手机号只回后 4 位掩码） |
| POST | `/customers/{id}/contacts` | `customer.create` | — | **未接** | 新增客户对接人（isPrimary 为真时自动把原主对接人降级） |
| PATCH | `/customer-contacts/{contactId}` | `customer.update` | 是 | **未接** | 修改客户对接人（强 ETag If-Match；可改 status 重新启用） |
| DELETE | `/customer-contacts/{contactId}` | `customer.delete` | 是 | **未接** | 删除客户对接人（软停用：status 置「停用」，历史单仍可读） |
| GET | `/customers/{id}/summary` | `customer.read` | — | **未接** | 客户档案汇总（单数/累计金额/最近单据/对接人；带 groupBy=contact 时附按对接人分组；金额需 view_price） |
| GET | `/masterdata/dedupe` | `customer.read` | — | ✓ | 疑似重复档案审核队列（待判 / 判为不同 / 已合并） |
| POST | `/masterdata/dedupe/{id}/keep-separate` | `customer.merge` | — | ✓ | 把疑似重复的一对判为不同（此后不再提示） |
| POST | `/masterdata/dedupe/{id}/reopen` | `customer.merge` | — | ✓ | 撤销「判为不同」，把对子放回待判 |
| POST | `/masterdata/dedupe/{id}/merge` | `customer.merge` | — | ✓ | 把疑似重复的两条档案合并为一条（source 并进 target，全库引用改向） |

## 供应商（`supplier`，11 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/suppliers` | `supplier.read` | — | ✓ | 供应商列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜） |
| POST | `/suppliers` | `supplier.create` | — | ✓ | 新增供应商（编号自由文本可空；供应商无金额字段，D49） |
| GET | `/suppliers/suggest` | `supplier.read` | — | ✓ | 建档防重：按名称提示已有相似供应商（只回 id/名称/相似度，D99） |
| GET | `/suppliers/{id}` | `supplier.read` | — | ✓ | 供应商详情（D15 跨公司不可见） |
| PATCH | `/suppliers/{id}` | `supplier.update` | 是 | ✓ | 修改供应商（强 ETag If-Match） |
| DELETE | `/suppliers/{id}` | `supplier.delete` | 是 | ✓ | 删除供应商（物理删除；被单据引用时 409 拒绝，危险动作，AI 默认禁止） |
| GET | `/suppliers/{id}/contacts` | `supplier.read` | — | **未接** | 供应商对接人列表（手机号只回后 4 位掩码） |
| POST | `/suppliers/{id}/contacts` | `supplier.create` | — | **未接** | 新增供应商对接人（isPrimary 为真时自动把原主对接人降级） |
| PATCH | `/supplier-contacts/{contactId}` | `supplier.update` | 是 | **未接** | 修改供应商对接人（强 ETag If-Match；可改 status 重新启用） |
| DELETE | `/supplier-contacts/{contactId}` | `supplier.delete` | 是 | **未接** | 删除供应商对接人（软停用：status 置「停用」，历史单仍可读） |
| GET | `/suppliers/{id}/summary` | `supplier.read` | — | **未接** | 供应商档案汇总（单数/累计金额/最近单据/对接人；带 groupBy=contact 时附按对接人分组；金额需 view_price） |

## 加工厂（`processor`，13 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/processors` | `processor.read` | — | ✓ | 加工厂列表（按名称/联系人检索；普通读不记审计，D49 不按编号全局搜） |
| POST | `/processors` | `processor.create` | — | ✓ | 新增加工厂（编号自由文本可空；主表只存基础资料，D49/D64） |
| GET | `/processors/suggest` | `processor.read` | — | ✓ | 建档防重：按名称提示已有相似加工厂（只回 id/名称/相似度，D99） |
| GET | `/processors/{id}` | `processor.read` | — | ✓ | 加工厂详情（D15 跨公司不可见） |
| PATCH | `/processors/{id}` | `processor.update` | 是 | ✓ | 修改加工厂（强 ETag If-Match；不改报价历史） |
| DELETE | `/processors/{id}` | `processor.delete` | 是 | ✓ | 删除加工厂（物理删除；被单据引用时 409 拒绝，危险动作，AI 默认禁止） |
| GET | `/processor-quotes` | `processor.read` | — | ✓ | 加工厂报价记录列表（按工序 + 日期区间比价；普通读不记审计，D64③） |
| POST | `/processor-quotes` | `processor.create` | — | ✓ | 新增加工厂报价记录（一次报价一行，只增不改，D64④） |
| GET | `/processors/{id}/contacts` | `processor.read` | — | **未接** | 加工厂对接人列表（手机号只回后 4 位掩码） |
| POST | `/processors/{id}/contacts` | `processor.create` | — | **未接** | 新增加工厂对接人（isPrimary 为真时自动把原主对接人降级） |
| PATCH | `/processor-contacts/{contactId}` | `processor.update` | 是 | **未接** | 修改加工厂对接人（强 ETag If-Match；可改 status 重新启用） |
| DELETE | `/processor-contacts/{contactId}` | `processor.delete` | 是 | **未接** | 删除加工厂对接人（软停用：status 置「停用」，历史单仍可读） |
| GET | `/processors/{id}/summary` | `processor.read` | — | **未接** | 加工厂档案汇总（单数/累计金额/最近单据/对接人；带 groupBy=contact 时附按对接人分组；金额需 view_price） |

## 库存批次（`inventory_qty`，8 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/inventory/batches` | `inventory_qty.read` | — | ✓ | 库存批次列表（按公司/商品/批次号或商品名检索；普通读不记审计，D38） |
| GET | `/inventory/batches/{id}` | `inventory_qty.read` | — | ✓ | 库存批次详情（四列口径 + 待执行占用来源；普通读不记审计，D38/D67） |
| GET | `/inventory/alerts` | `inventory_qty.read` | — | ✓ | 低库存预警（可用量 < 最近 30 天日均出库 × 7 × (1+提前量)；只读不记审计，D104） |
| POST | `/inventory/batches/{batchId}/cost-adjustments` | `inventory_qty.update` | — | ✓ | 提交批次成本更正（服务端自动判 T1/T2/T3；只改成本不改数量，T1 直接生效、T2 待审批、T3 拒绝） |
| GET | `/inventory/batches/{batchId}/cost-adjustments` | `inventory_qty.read` | — | ✓ | 批次成本更正历史（含档位/状态/差额/审批人；无看价权限时金额置空） |
| POST | `/inventory/cost-adjustments/{id}/approve` | `inventory_qty.approve` | 是 | ✓ | 审批通过 T2 成本更正（审批时复查下游引用；已结算则拒绝；AI 禁止审批且必须给原因） |
| POST | `/inventory/cost-adjustments/{id}/reject` | `inventory_qty.approve` | 是 | ✓ | 驳回 T2 成本更正（必须写明原因；AI 禁止审批且必须给原因） |
| GET | `/inventory/batches/export` | `inventory_qty.export` | — | **未接** | 库存批次列表导出 CSV（全量、按筛选条件；敏感读，记审计） |

## 库存流水（`inventory_flow`，1 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/inventory/flows` | `inventory_flow.read` | — | ✓ | 库存流水列表（按公司/批次/来源单据检索；只追加流水，普通读不记审计，D2①/D67④） |

## 盘点（`stocktake`，6 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/stocktakes` | `stocktake.read` | — | ✓ | 盘点单列表（按公司/状态/单号检索；普通读不记审计，D15） |
| POST | `/stocktakes/increases` | `stocktake.create` | — | ✓ | 发起盘盈单（实盘量 > 账面量；差异量服务端算；盘盈走冲正流水 D47；权限 stocktake.create，D71） |
| POST | `/stocktakes/decreases` | `stocktake.delete` | — | ✓ | 发起盘亏单（实盘量 < 账面量；只追加冲正流水、不物理删除 D47；权限 stocktake.delete = 仅删减，D71） |
| GET | `/stocktakes/{id}` | `stocktake.read` | — | ✓ | 盘点单详情（内嵌审批判定 approvable；普通读不记审计，D47） |
| POST | `/stocktakes/{id}/approve` | `stocktake.approve` | 是 | ✓ | 审批盘点单（通过后追加库存流水、不物理删除 D47；不直接改批次数量 D67；AI 禁止审批 D52） |
| POST | `/stocktakes/{id}/reject` | `stocktake.approve` | 是 | **未接** | 驳回盘点单（必须写明原因；驳回不动库存、不写流水；AI 禁止审批且必须给原因） |

## 销售单 E（`sales`，11 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/sales-orders` | `sales.read` | — | ✓ | 销售单列表（按公司/客户/状态/单号或客户名检索；普通读不记审计，D15；无看价权限时金额字段为 null，D79） |
| POST | `/sales-orders` | `sales.create` | — | ✓ | 开销售单（单号服务端按 D16 生成；AI 默认禁止开单；破下限需走 platform 审批 D20） |
| GET | `/sales-orders/{id}` | `sales.read` | — | ✓ | 销售单详情（内嵌收款记录 + 取消判定 cancelable；无看价权限时金额字段为 null；看过金额记 amount.detail，D21/D24/D79） |
| PATCH | `/sales-orders/{id}` | `sales.update` | 是 | ✓ | 修改销售单（仅「进行中」可改；强 ETag If-Match；破下限需走 platform 审批 D20） |
| POST | `/sales-orders/{id}/ship` | `sales.ship` | 是 | ✓ | 销售出库（D72 扣减批次可用量 + 生成 C 单草稿，同事务；仅「进行中」可出库；权限 sales.ship，D85；AI 默认禁止） |
| POST | `/sales-orders/{id}/complete` | `sales.approve` | 是 | ✓ | 客户签收完成：已发货 → 已完成（D94 ③：按批次反查来源 A/B 单必须全部已完成，否则 409；D94 ④：签收走 approve，不是 ship） |
| POST | `/sales-orders/{id}/cancel` | `sales.delete` | 是 | ✓ | 取消销售单（复用 assertCancelable：有下游不可取消、先取消下游；危险动作 AI 默认禁止） |
| GET | `/sales-orders/{id}/receipts` | `sales.read` | — | ✓ | 销售单收款记录（内嵌收款台账，退款为负数行；普通读不记审计，D24/D34） |
| POST | `/sales-orders/{id}/receipts` | `sales.update` | — | ✓ | 追加收款记录（退款为负数行；钱账危险动作，AI 默认禁止且必须给原因，D34/D40/D52①） |
| GET | `/sales-orders/{id}/print` | `sales.read` | — | ✓ | 销售单打印（客户联，HTML 文本；金额受看价权限约束，无权限为 null） |
| GET | `/sales-orders/export` | `sales.export` | — | ✓ | 销售单列表导出 CSV（全量、按筛选条件；敏感读，记审计） |

## 客户退货 R（`customer_return`，4 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/customer-returns/{id}/complete` | `customer_return.approve` | 是 | ✓ | 确认客户退货并入库（审批动作） |
| GET | `/customer-returns` | `customer_return.read` | — | ✓ | 客户退货单列表（按公司/原 E 单/状态/单号检索；普通读不记审计，D15） |
| POST | `/customer-returns` | `customer_return.create` | — | ✓ | 登记客户退货（退货退款/仅退款；退款只走收款记录负数行 D40；R 全额冲回原 E 单 D36；AI 禁止冲正 D52） |
| GET | `/customer-returns/{id}` | `customer_return.read` | — | ✓ | 客户退货单详情（普通读不记审计，D54 ②） |

## 采购单 A（`purchase`，10 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/purchase-orders/{id}/complete` | `purchase.approve` | 是 | ✓ | 完成采购单并入库 |
| GET | `/purchase-orders` | `purchase.read` | — | ✓ | 采购单列表（按公司/供应商/状态/单号或供应商名检索；普通读不记审计，D15） |
| POST | `/purchase-orders` | `purchase.create` | — | ✓ | 开采购单（单号服务端按 D16 生成；AI 默认禁止开单；本批不做入库锁价 D5） |
| GET | `/purchase-orders/{id}` | `purchase.read` | — | ✓ | 采购单详情（内嵌取消判定 cancelable；普通读不记审计，D21） |
| PATCH | `/purchase-orders/{id}` | `purchase.update` | 是 | ✓ | 修改采购单（仅「进行中」可改；强 ETag If-Match；成本更正走 platform 审批 D37） |
| POST | `/purchase-orders/{id}/ship` | `purchase.ship` | 是 | ✓ | 采购发货：进行中 → 在途，按明细行记去向（回仓库 / 直发加工厂，D94 ①）；发货即建批次并计入在途量 |
| POST | `/purchase-orders/{id}/ship/revoke` | `purchase.ship` | 是 | ✓ | 撤销采购发货：在途 → 进行中，必须给原因（D94 ⑤：点过发货就只能撤销或到货确认） |
| POST | `/purchase-orders/{id}/receive` | `purchase.approve` | 是 | ✓ | 采购到货确认：在途 → 已完成，按行分流建批次（直发加工厂的批次挂 heldByProcessorId，D94 ①/④） |
| POST | `/purchase-orders/{id}/cancel` | `purchase.delete` | 是 | ✓ | 取消采购单（复用 assertCancelable：已完成/已结算不可取消、有下游先取消下游；AI 禁止） |
| GET | `/purchase-orders/export` | `purchase.export` | — | **未接** | 采购单列表导出 CSV（全量、按筛选条件；敏感读，记审计） |

## 供应商退货 S（`supplier_return`，5 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/supplier-returns/{id}/complete` | `supplier_return.approve` | 是 | ✓ | 确认供应商退货并出库（审批动作） |
| POST | `/supplier-returns/{id}/cancel` | `supplier_return.delete` | 是 | ✓ | 取消进行中的供应商退货并释放待执行库存占用 |
| GET | `/supplier-returns` | `supplier_return.read` | — | ✓ | 供应商退货单列表（按公司/原 A 单/状态/单号检索；普通读不记审计，D15） |
| POST | `/supplier-returns` | `supplier_return.create` | — | ✓ | 登记供应商退货（只做退钱、冲减应付，F4c；AI 禁止冲正 D52） |
| GET | `/supplier-returns/{id}` | `supplier_return.read` | — | ✓ | 供应商退货单详情（普通读不记审计，D54 ②） |

## 加工单 B（`processing`，10 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/processing-orders` | `processing.read` | — | ✓ | 加工单列表（按公司/加工厂/状态/单号或加工厂名检索；普通读不记审计，D15） |
| POST | `/processing-orders` | `processing.create` | — | ✓ | 开加工单（单号服务端按 D16 生成；至少 1 条材料投入 F2b；费用行 ≥ 0 D39；AI 默认禁止开单） |
| GET | `/processing-orders/{id}` | `processing.read` | — | ✓ | 加工单详情（含产出批次占位、损失记录与取消判定 cancelable；普通读不记审计，D21/§9） |
| PATCH | `/processing-orders/{id}` | `processing.update` | 是 | ✓ | 修改加工单（仅「进行中」可改；强 ETag If-Match；损耗量验收时一次填入，F3） |
| POST | `/processing-orders/{id}/cancel` | `processing.delete` | 是 | ✓ | 取消加工单（复用 assertCancelable：有下游不可取消、先取消下游；危险动作 AI 默认禁止） |
| POST | `/processing-orders/{id}/ship` | `processing.ship` | 是 | ✓ | 加工发货：进行中 → 在途。materials 段只带 transitStage（料去加工厂，方向由单据上的加工厂决定）；finished 段带 transitTo（回仓/直发客户 |
| POST | `/processing-orders/{id}/ship/revoke` | `processing.ship` | 是 | ✓ | 撤销加工发货：在途 → 进行中，必须给原因（D94 ⑤） |
| POST | `/processing-orders/{id}/receive` | `processing.approve` | 是 | ✓ | 加工到货确认：在途 → 已完成（D94 ②/④：到货确认走 approve，与改单 update 分离） |
| POST | `/processing-orders/{id}/complete` | `processing.approve` | 是 | ✓ | 完成加工单：确认损耗、扣材料、生成产出批次并锁价 |
| GET | `/processing-orders/{id}/print` | `processing.read` | — | ✓ | 加工单打印（发厂联，HTML 文本） |

## 内部交易 N（`internal_trade`，8 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/internal-trade-orders` | `internal_trade.read` | — | ✓ | 内部交易单列表（按发出/接收公司、状态、单号检索；普通读不记审计，D15） |
| POST | `/internal-trade-orders` | `internal_trade.create` | — | ✓ | 开内部交易单（单号服务端按 D16 生成；内部价手工填 D68①；明细引用发出公司批次 D22） |
| GET | `/internal-trade-orders/{id}` | `internal_trade.read` | — | ✓ | 内部交易单详情（内嵌四态取消判定 cancelable；普通读不记审计，D21 / D68②） |
| PATCH | `/internal-trade-orders/{id}` | `internal_trade.update` | 是 | ✓ | 修改内部交易单（仅「进行中」可改；强 ETag If-Match；内部价手工填 D68①） |
| POST | `/internal-trade-orders/{id}/cancel` | `internal_trade.delete` | 是 | ✓ | 取消内部交易单（四态映射后复用 assertCancelable：已完成/已取消不可取消、有下游先取消下游；AI 禁止） |
| POST | `/internal-trade-orders/{id}/dispatch` | `internal_trade.ship` | 是 | ✓ | 确认发货：N 单进入在途，锁定发出公司批次可用量（D22 / D31 / D68③） |
| POST | `/internal-trade-orders/{id}/dispatch-revoke` | `internal_trade.ship` | 是 | ✓ | 撤销发货：N 单退回进行中，释放在途占用（保留审计） |
| POST | `/internal-trade-orders/{id}/receive` | `internal_trade.approve` | 是 | ✓ | 确认 N 单到货并将占用批次转入接收公司（审批动作；D22 / D31 / D68③ / D86） |

## 结算单 C（`settlement`，4 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/settlement-orders` | `settlement.read` | — | ✓ | 结算单列表（按公司/状态/来源单类型/单号检索；无看价权限时金额字段为 null，D15 / D27 / D78） |
| GET | `/settlement-orders/{id}` | `settlement.read` | — | ✓ | 结算单详情（内嵌确认判定 confirmable；无 settlement.view_price 时金额字段为 null，D27 / D78；看过金额记 amount.detail |
| POST | `/settlement-orders/{id}/confirm` | `settlement.approve` | 是 | ✓ | 确认结算（待确认 → 已结算；一期一单一次 D19；AI 禁止审批 D52；确认错了可撤销 D88） |
| POST | `/settlement-orders/{id}/unsettle` | `settlement.approve` | 是 | ✓ | 撤销结算（已结算 → 待确认；整单退回并清空结算期快照，必需原因且快照原值进审计；D88；AI 禁止审批 D52） |

## 提成（`commission`，3 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/commission-rates` | `commission.read` | — | ✓ | 提成比例配置列表（按公司 / 员工检索；普通读不记审计，D15 / D77） |
| POST | `/commission-rates` | `commission.create` | — | ✓ | 新增提成比例配置（同员工 + 公司 + 生效日唯一；AI 默认禁止，D77） |
| DELETE | `/commission-rates/{id}` | `commission.delete` | — | ✓ | 删除提成比例配置（已结算单靠快照冻结，不受影响；AI 默认禁止，D77 ④） |

## 支付（`payment`，4 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/payments/{channel}/callback` | `payment.create` | — | **未接** | 第三方支付异步回调：验签→金额校验→幂等入账，匿名可达 |
| POST | `/sales-orders/{orderId}/payment-requests` | `payment.create` | — | ✓ | 发起客户扫码收款：服务端按应收余额算金额并生成支付二维码（不接收金额入参；同一单同渠道未过期的待支付单直接复用） |
| GET | `/payments/{id}` | `payment.read` | — | ✓ | 查询待支付单（含二维码与金额）；已过期但未写入库的 pending 单在这里返回 expired |
| POST | `/payments/mock/{providerOrderNo}/confirm` | `payment.create` | — | ✓ | mock 模式下模拟第三方平台「客户已付款」：复用回调入账路径写收款；live 模式返回 404（不暴露存在性） |

## 订阅计费（`billing`，2 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/billing/subscription` | `billing.read` | — | **未接** | 读取当前公司的订阅套餐与到期情况 |
| PATCH | `/billing/subscription` | `billing.update` | — | **未接** | 运营端手动调整套餐与到期日（写审计，需 X-Reason） |

## 工作台（`workbench`，1 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/todos` | `workbench.read` | — | ✓ | 工作台待办：按权限点 × 动作与本人负责聚合真实单据笔数（普通读不记审计） |

## 利润报表（`profit_report`，2 个端点）

| 方法 | 路径 | 权限 | If-Match | 前端已接 | 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/reports/profit` | `profit_report.read` | — | ✓ | 按期间汇总已结算 C 单毛利 + B 单全损耗，给出净毛利（D43 / #97；金额受 profit_report.view_price 管，无权限为 null，D78） |
| GET | `/reports/profit/losses` | `profit_report.read` | — | ✓ | 未归属损失下钻：期间内 B 单全损耗损失及归属状态（D43；金额受 profit_report.view_price 管，无权限为 null，D78） |

## 前端还没接的端点（后端已就绪）

| 方法 | 路径 | 权限 | 归属页面 |
| --- | --- | --- | --- |
| GET | `/customers/{id}/contacts` | `customer.read` | 档案页 → 对接人抽屉 |
| POST | `/customers/{id}/contacts` | `customer.create` | 档案页 → 对接人抽屉 |
| PATCH | `/customer-contacts/{contactId}` | `customer.update` | 档案页 → 对接人抽屉 |
| DELETE | `/customer-contacts/{contactId}` | `customer.delete` | 档案页 → 对接人抽屉 |
| GET | `/customers/{id}/summary` | `customer.read` | 档案页 → 汇总卡（单数／累计金额／最近单据／流水） |
| GET | `/suppliers/{id}/contacts` | `supplier.read` | 档案页 → 对接人抽屉 |
| POST | `/suppliers/{id}/contacts` | `supplier.create` | 档案页 → 对接人抽屉 |
| PATCH | `/supplier-contacts/{contactId}` | `supplier.update` | 档案页 → 对接人抽屉 |
| DELETE | `/supplier-contacts/{contactId}` | `supplier.delete` | 档案页 → 对接人抽屉 |
| GET | `/suppliers/{id}/summary` | `supplier.read` | 档案页 → 汇总卡（单数／累计金额／最近单据／流水） |
| GET | `/processors/{id}/contacts` | `processor.read` | 档案页 → 对接人抽屉 |
| POST | `/processors/{id}/contacts` | `processor.create` | 档案页 → 对接人抽屉 |
| PATCH | `/processor-contacts/{contactId}` | `processor.update` | 档案页 → 对接人抽屉 |
| DELETE | `/processor-contacts/{contactId}` | `processor.delete` | 档案页 → 对接人抽屉 |
| GET | `/processors/{id}/summary` | `processor.read` | 档案页 → 汇总卡（单数／累计金额／最近单据／流水） |
| POST | `/stocktakes/{id}/reject` | `stocktake.approve` | 冲正页 → 盘点单驳回 |
| GET | `/purchase-orders/export` | `purchase.export` | 采购单列表 → 导出 CSV |
| GET | `/inventory/batches/export` | `inventory_qty.export` | 库存列表 → 导出 CSV |
| GET | `/billing/subscription` | `billing.read` | 设置中心 → 订阅套餐 |
| PATCH | `/billing/subscription` | `billing.update` | 设置中心 → 订阅套餐 |
| POST | `/employees/me/phone/request` | `employee.update` | 设置中心 → 我的账号 → 换手机号 |
| POST | `/employees/me/phone/confirm` | `employee.update` | 设置中心 → 我的账号 → 换手机号 |

## 封装已写、页面没挂的端点（最省力的活）

联想端点前端已有客户端封装与组件，只差挂到开单表单里：

- 客户端：`apps/web/src/components/masterdata-suggest-api.ts`（`masterdataSuggestApi.suggest(kind, { companyId, name })`）
- 组件：`apps/web/src/components/SuggestHint.tsx`（`<SuggestHint kind="customer" name={name} companyId={companyId} onPick={...} />`）
- 要挂的位置：销售开单（客户）、采购开单（供应商）、加工开单（加工厂）、商品录入（商品）

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/products/suggest` | `product.read` |
| GET | `/customers/suggest` | `customer.read` |
| GET | `/suppliers/suggest` | `supplier.read` |
| GET | `/processors/suggest` | `processor.read` |

## 后端确实没有的能力（前端不许画）

| 想画的东西 | 后端现状 |
| --- | --- |
| 销售单「审批」按钮 | 销售单没有审批端点，只有 `ship`（出库）与 `cancel`（取消）；审批只存在于采购 `complete`、加工 `complete`、退货 `complete`、盘点 `approve` |
| 单据「删除」 | 一律软停用／取消，没有物理删除端点 |
| 批量操作（批量发货／批量取消） | 没有批量端点，只能逐单 |
| 附件／图片上传 | 没有上传端点 |
| 打印 PDF | 打印是服务端渲染的 HTML 文本（`/print`），没有 PDF 端点 |
| 销售／客户统计图表 | 只有 `profit_report` 两个端点与 `commission` 三个，其余图表没有数据源 |

