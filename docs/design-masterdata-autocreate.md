# 主数据「开单即建档」与相似度审核合并

最近更新：2026-11-16 ｜ 需求提出：负责人 ｜ 状态：**已拍板**（§十 六条已裁定，见表格）

## 〇、负责人已拍板的六条（本设计的硬约束）

| # | 决定 | 落进设计的位置 |
|---|---|---|
| 1 | 公司有**四种来源**，按单据类型分治；自己公司只有老板能改、其他人只读，老板个人信息其他人看不到 | §一·五 |
| 2 | **每个有开单权限的人都自动具备静默建档**，本人不知情、不提示；主动增删对接公司仍受 `create`/`update`/`delete` 控制 | §二、§六 |
| 3 | 疑似重复**不阻塞**单据保存与流转 | §二·4、§六 |
| 4 | 阈值按设计默认（名称 trigram ≥0.85，商品 0.7 + 规格相同） | §四 |
| 5 | **合并权限拆开**：新增第 9 个动作 `merge`（改 `domains.ts`，红线，已授权） | §五、§七 |
| 6 | **同名商品必提示**（不看规格） | §四 |

## 一、要解决的现状问题

**现状是「先建档，才能开单」**，与业务实际相反：业务员先接到单，再补资料。

| 事实（源码为准） | 位置 | 后果 |
|---|---|---|
| `sales_order.customer_id uuid NOT NULL REFERENCES customer (id) ON DELETE RESTRICT` | `apps/api/migrations/0013_sales_orders.sql:29` | 必须先有客户才能存销售单 |
| `sales_order_line.product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT` | `apps/api/migrations/0013_sales_orders.sql:56` | 必须先有商品才能填行 |
| `purchase_order.supplier_id uuid NOT NULL REFERENCES supplier (id)` | `apps/api/migrations/0010_purchase_orders.sql:35` | 采购单同理 |
| `customer` 无任何唯一约束，只有 `(tenant_id, company_id, name)` 普通索引 | `0005_masterdata_customer.sql:38` | 同一客户可被重复录入十次，谁也没拦住 |
| `product` 无唯一约束，`aliases text[]` 用于检索但没人维护 | `0004_masterdata_product.sql:22-38` | 同物异名各录一条，库存与售价口径分裂 |
| 列表接口已支持 `keyword`（ILIKE 名称/联系人/电话） | `packages/contracts/src/customers.ts:44-50`、`repo-customers.ts:157-160` | 联想**已有基础**，缺轻量 suggest 与「就地新建」 |
| 无 `pg_trgm` 扩展（迁移里从未 `CREATE EXTENSION`） | 全仓 `apps/api/migrations/*.sql` | 相似度只能应用层算 |
| 单据类型字母表：`A 采购单 / B 加工单 / E 销售单 / N 内部交易单 / C 结算单 / R 客户退货 / S 供应商退货 / I 盘点调整` | `packages/contracts/src/numbering.ts:6-15` | 决定「哪类单碰哪类主数据」 |
| `internal_trade_order` 有 `from_company_id` / `to_company_id`，且 `CHECK (company_id = from_company_id)`、`from<>to` | `0015_internal_trade_orders.sql:21-40` | N 单两端都是**我方子公司**，属 `company` 表 |

**结论**：缺的不是能力，而是顺序。把建档挪进开单流程，同时补三道闸：就地新建、静默建档、相似度审核。

## 一·五、公司的四种来源（负责人裁定，按单据类型分治）

这是本次设计的核心分野：**「公司」不是一个概念，是四个**。任何把四者混成一个「公司档案」的写法都会串数据。

| 来源 | 是谁 | 存哪 | 谁能改 | 谁看得到 |
|---|---|---|---|---|
| ① 自己公司 | 老板的公司（`employee.is_owner` 那个人所属的 `company`） | `company` 表 | **只有老板本人**；其他人只读（硬性） | 老板本人 + 该公司所有从属员工（只读） |
| ② 供应商 / 加工厂 | A 采购单的供应商、B 加工单的加工厂 | `supplier` 表 / `processor` 表（现有字段照用） | 有对应 `update` 权限的人 | 按 `company_id` 隔离 |
| ③ 客户 | E 销售单的**公司与对接人绑在一起=一份客户资料** | `customer` 表（现有字段先存；后续有权限的人补地址、税号等财务字段） | 开单静默建档；财务字段补录需 `customer.update` | 按 `company_id` 隔离 |
| ④ 子公司 | N 内部交易单的 `from_company_id` / `to_company_id` | `company` 表 | 有公司管理权限的人 | **只在该权限下、在「管理子公司」页面可见** |

**硬性隔离（安全底线，写进用例）**
- 老板个人信息（`employee` 里 `is_owner=true` 那条的姓名/手机/会话）**除本人外一律不可读**，任何列表、联系人下拉、审计回显都不得带出。
- ① 自己公司：非老板账号调 `PATCH /companies/{id}` → 403；界面字段只读且不显示保存按钮，顶部提示「公司资料由负责人维护」。
- ④ 子公司：`GET /companies` 只回调用者有权访问的公司；无 `company.read` 的账号连菜单都不渲染（网关仍 403 兜底）。
- ②③ 的财务字段（税号、开户行、地址）：仅 `customer.update` / `supplier.update` 可写；只读用户看到脱敏或空，不显示「无权限」以外的信息。

## 二、目标交互（员工视角）

1. **打字即联想**：开单页的客户/供应商/加工厂/商品输入框，输入 2 个字符起调 suggest（防抖 250ms），返回 `[{id, 名称, 编号, 电话/规格}]`；回车或点选即填入，并带出默认值（客户→账期；商品→单位、默认售价）。
2. **联想里没有就新建**：下拉底部固定「+ 新建客户：<当前输入>」，点开 4 字段内联小表单（名称必填，联系人、电话、账期选填），不必离开单据页。
3. **保存单据 = 建档完成，且是静默的**：内联新建的对象随单据一起提交，后端在同一事务里先建主数据再建单据，失败整体回滚。**界面上不出现「已建档」「已提交审核」之类提示**——负责人明确要求建档对本人透明（他只知道单开成功了）。
4. **疑似重复不打断开单**：后端发现相似度超阈值时照常建档、照常存单，只给这条主数据打「疑似重复」标记并进审核队列；员工侧无感，由有权限的人在审核台收口。
5. **按单据类型决定碰哪套主数据**（不可越界）：
   | 单据 | 主数据 | 建立方式 |
   |---|---|---|
   | A 采购单 | `supplier` | 静默建档 + 内联新建 |
   | B 加工单 | `processor` | 静默建档 + 内联新建 |
   | E 销售单 | `customer`（公司+对接人一份） | 静默建档 + 内联新建 |
   | N 内部交易单 | `company`（两端子公司） | **只能选，不能建**（建公司是公司管理页的事，受权限） |
   | C 结算单 / R 客户退货 / S 供应商退货 / I 盘点调整 | 不建档 | 只能引用已有主数据 |

## 三、数据模型改动（一个迁移文件）

迁移名：`apps/api/migrations/<14 位时间戳>_masterdata_autocreate.sql`（决策号 D92）

```sql
-- 1. 三类主数据各加「建档来源」与「去重状态」
ALTER TABLE customer ADD COLUMN origin text NOT NULL DEFAULT '后台录入'
  CHECK (origin IN ('后台录入','开单自动建档'));
ALTER TABLE customer ADD COLUMN dedupe_state text NOT NULL DEFAULT '正常'
  CHECK (dedupe_state IN ('正常','疑似重复','已确认独立'));
-- supplier / product / processor 同款两列

-- 2. E 单客户的财务字段（负责人：后续由有权限的人补录）
ALTER TABLE customer ADD COLUMN address    text;
ALTER TABLE customer ADD COLUMN tax_no     text;
ALTER TABLE customer ADD COLUMN bank_name  text;
ALTER TABLE customer ADD COLUMN bank_account text;
ALTER TABLE customer ADD COLUMN invoice_title text;

-- 3. 公司来源标记（区分自己公司 / 子公司；财务主体不混用）
ALTER TABLE company ADD COLUMN source text NOT NULL DEFAULT '子公司'
  CHECK (source IN ('自己公司','子公司'));

-- 4. 审核队列
CREATE TABLE masterdata_dedupe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  entity text NOT NULL CHECK (entity IN ('customer','supplier','processor','product')),
  entity_id uuid NOT NULL,            -- 新录入的那条（疑似方）
  candidate_id uuid NOT NULL,          -- 命中的既有那条（保留方候选）
  score numeric(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  matched_by text NOT NULL,            -- name_phone / name_only / name_alias / spec
  state text NOT NULL DEFAULT '待审' CHECK (state IN ('待审','已合并','已确认独立')),
  resolved_by uuid REFERENCES employee (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT masterdata_dedupe_pair_key UNIQUE (entity, entity_id, candidate_id)
);
CREATE INDEX masterdata_dedupe_pending_idx
  ON masterdata_dedupe (tenant_id, company_id, state, created_at DESC);
```

合并**不删行**：被并方 `status='停用'`，历史单据引用改指保留方，审计留痕。`ON DELETE RESTRICT` 本来就删不掉。

## 四、相似度怎么算（应用层，无 pg_trgm）

判定顺序（命中即停，写 `matched_by`）：

| 顺序 | 依据 | 阈值 | matched_by |
|---|---|---|---|
| 1 | 同公司内电话相同（客户/供应商/加工厂，只比数字） | 1.0 | `name_phone` |
| 2 | 名称规范化后完全相同（去空格、全半角统一、去「有限公司/公司/店」等后缀、小写） | 1.0 | `name_only` |
| 3 | 名称 trigram Jaccard ≥ 0.85 | 0.85–1.0 | `name_only` |
| 4 | 商品：名称 trigram ≥ 0.7 **且** 规格规范化后相同 → `spec`；命中 `aliases` 任一项 → `alias` | 0.7–1.0 | `spec` / `alias` |

**负责人第 6 条：同名商品必提示**。因此商品额外加一条**强规则**：规范化后名称完全相同 → 无论规格是否相同，一律进队列（`matched_by='name_only'`，`score=1.0`）。规格不同时队列里单独标 `note='同名不同规格'`，供审核人一眼看出该「另起一条」还是「合并成一条多规格」。

trigram：对规范化名称取 3 字符滑窗集合（含首尾边界符），`score=|A∩B|/|A∪B|`。纯 JS 无依赖。候选范围：同 `tenant_id + company_id`、`status='启用'`、上限 500 条（名称前缀 + trigram 粗筛，避免全表扫）。阈值集中 `apps/api/src/modules/masterdata/dedupe/thresholds.ts`。

## 五、审核台与合并语义

| 操作 | 端点 | 权限（新动作） | 语义 |
|---|---|---|---|
| 待审列表 | `GET /api/v1/masterdata/dedupe?entity=&state=待审` | 对应域 `read` | 按 score 降序 |
| 合并 | `POST /api/v1/masterdata/dedupe/{id}/merge` body `{keepId, mergeId}` | 对应域 **`merge`** | 见下 |
| 确认独立 | `POST /api/v1/masterdata/dedupe/{id}/keep-separate` | 对应域 **`merge`** | `dedupe_state='已确认独立'` |

**第 9 个动作 `merge`（负责人第 5 条：拆开权限管理）**
- `packages/contracts/src/domains.ts` 的动作表从 8 个扩到 9：`read/create/update/approve/ship/delete/view_price/export` + **`merge`（合并主数据）**。
- 语义边界写清楚：`update` = 改一条的属性；`merge` = 把两条并成一条并改所有单据引用。**两者不可互相代替**（这正是 2026-11-15 「发货借用 update」的同类教训）。
- 默认预设：只给「老板」「开发者」（或按负责人意见给到主管级），业务员预设不含 `merge`。
- 红线动作：改 `domains.ts` 必须同步 `docs/decisions.md`，本次记为 D92。

合并事务内顺序（固定）：
1. 校验两条同公司、同实体、都未停用、不是同一条；
2. 把引用 `mergeId` 的单据全部改指 `keepId`：`sales_order.customer_id`、`customer_return.customer_id`、`purchase_order.supplier_id`、`supplier_return.supplier_id`、加工单的 `processor_id`、各单据行 `product_id`（逐个 `UPDATE … WHERE x_id = mergeId`）；
3. 空字段合并：`keepId` 为 null 而 `mergeId` 有值则补过去；`aliases` 取并集；
4. `mergeId`：`status='停用'`、`version+1`；
5. 队列行 `state='已合并'`、写 `resolved_by/resolved_at`；
6. 审计两条（`*.merge` 含 keepId/mergeId/影响行数、被并方 update）。

## 六、权限与安全四类

**权限点（一律 `allowsScope`，代码里不出现角色常量）**
- 联想：`customer.read` / `supplier.read` / `product.read` / `processor.read`
- 内联新建 + **静默建档**：**不额外要求主数据 `create`**。门槛是「你有这张单的开单权」（`sales.create` / `purchase.create` / `internal_trade.create` 等）。负责人第 2 条：每个有开单权限的人都自动具备。岗位预设**不需要**改（省一次预设变更）。
- 主动增删对接公司/客户/商品（主数据页面）：仍要 `create` / `update` / `delete`
- 审核台：`merge`（列表只要 `read`）
- 自己公司编辑：老板本人；判定用 `employee.is_owner` 归属关系，不用「职位」字符串

**安全四底线自查**
- 用户安全：①老板个人信息（`is_owner` 那条 employee）除本人外不可读——列表、下拉、审计回显全部过滤，用例层加断言；②静默建档不提示但仍记审计（本人无感，管理员可查）；③合并二次确认 + 回显两条名称，只停用不删除，可回滚。
- 数据安全：单文件单事务；新列有默认值不 backfill；`masterdata_dedupe` 带 `tenant_id + company_id`；财务字段（税号/开户行）只有 `update` 能写，日志脱敏，不入 `localStorage`。
- 产品安全：疑似重复不阻塞；`dedupe_state` 三值固定；合并返回影响行数并在界面展示；N 单不能建公司（避免账簿归属分裂）。
- 服务器安全：无新依赖、无外部调用；候选上限 500；队列走复合索引；suggest 限 20 条 + 参数上限校验。

## 七、一期改动清单

| # | 改动 | 文件 | 红线 |
|---|---|---|---|
| 1 | 迁移（多列 + 1 表 + 1 索引 + `company.source`） | `apps/api/migrations/<ts>_masterdata_autocreate.sql` | ✅ 迁移 |
| 2 | **动作表 8→9：新增 `merge`** | `packages/contracts/src/domains.ts` | ✅ 契约 |
| 3 | suggest 四端点 + 单据保存支持 draft + dedupe 三端点 | `packages/contracts/src/{customers,suppliers,products,processors,masterdata-dedupe}.ts` | ✅ 契约 |
| 4 | 相似度实现 | `apps/api/src/modules/masterdata/dedupe/{normalize,trigram,thresholds}.ts` | — |
| 5 | 静默建档（事务内 resolve） | `apps/api/src/modules/{sales,purchase,processing,internal-trades}/usecases/*.ts` | — |
| 6 | 审核台用例 + 合并事务 | `apps/api/src/modules/masterdata/usecases/dedupe.ts` | — |
| 7 | 老板资料隔离 | `apps/api/src/modules/platform/**`（employee 读过滤）+ 用例断言 | — |
| 8 | 前端联想组件 + 三类开单页接入 | `apps/web/src/components/EntityPicker.tsx` 等 | — |
| 9 | 前端审核台 | `apps/web/src/pages/masterdata/dedupe/**` | — |
| 10 | 前端：自己公司只读卡 + 管理子公司页按权限显隐 + 客户财务字段补录 | `apps/web/src/pages/companies/**`、`customers/**` | — |
| 11 | 决策记录 **D92** | `docs/decisions.md` | ✅ decisions |
| 12 | 迁移用 14 位时间戳 + `node tools/check-numbering.mjs --base origin/main` | — | — |

端点：

| operationId | 方法与路径 | 说明 |
|---|---|---|
| `customer.suggest` | `GET /api/v1/customers/suggest?q=&companyId=&limit=20` | 回 `id/name/customer_no/contact_phone/credit_term_days` |
| `supplier.suggest` | `GET /api/v1/suppliers/suggest?q=&companyId=` | 同上 |
| `processor.suggest` | `GET /api/v1/processors/suggest?q=&companyId=` | B 加工单用 |
| `product.suggest` | `GET /api/v1/products/suggest?q=&companyId=` | 匹配 `name` 与 `aliases`，回 `id/name/product_no/specification/unit/default_sale_price` |
| `masterdata.dedupe.list` | `GET /api/v1/masterdata/dedupe` | 待审列表 |
| `masterdata.dedupe.merge` | `POST /api/v1/masterdata/dedupe/{id}/merge` | 要 `merge` 动作 |
| `masterdata.dedupe.keepSeparate` | `POST /api/v1/masterdata/dedupe/{id}/keep-separate` | 要 `merge` 动作 |

单据保存入参扩展（向后兼容）：`customerId` 与 `customerDraft` 二选一，同传 422；`lines[].productId` 与 `lines[].productDraft` 二选一。

## 八、验收命令

```
node tools/check-numbering.mjs --base origin/main    # 必须 [ok]
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests/run.ps1
```

用例必须覆盖：
1. 有 `sales.create` 但**没有** `customer.create` 的账号带 draft 存单 → 成功建档（`origin='开单自动建档'`）且单据引用新客户——**证明静默建档不受主数据 create 限制**；
2. 无 `sales.create` 的账号 → 403，且单据与主数据都没落库；
3. 响应体与前端**不出现**「已建档」提示字段（静默口径）；
4. 同名客户二次录入 → 存单成功 + 客户建成 + `dedupe_state='疑似重复'` + 队列 `score=1.0 matched_by=name_only`；
5. 电话相同名字不同 → `name_phone`；商品别名命中 → `alias`；**同名商品规格不同 → 仍进队列且 `note='同名不同规格'`**；
6. 合并：两单分别引用 A、B，B 并入 A → 两单都指向 A、B 停用、队列 `已合并`、审计两条、响应含影响行数；
7. 只有 `update` 无 `merge` 的账号调合并 → 403；跨公司合并 422；自己并自己 422；
8. 非老板账号 `PATCH` 自己公司 → 403；非本人读 `is_owner` 员工详情 → 404/403 且列表中不出现；
9. N 单传 `companyDraft` → 422「公司只能选不能建」；
10. 确认独立 → 不再进队列。

## 九、明确不做（一期）

- 不装 `pg_trgm`、不做跨公司查重（`company_id` 隔离是 D15 铁律）
- 不做自动合并（阈值再高也要人点头）
- 不做主数据版本 diff 页（只留审计）
- 不做 N 单开户公司、不做批量导入
- 不做客户财务字段的「自动带出」（先手动补录）

## 十、拍板记录（已完结）

| # | 问题 | 负责人裁定 |
|---|---|---|
| 1 | 「公司资料」指哪个 | 四种来源分治：自己公司（老板维护、他人只读）/ A B 单=供应商或加工厂 / E 单=客户（公司+对接人一份，财务字段后续由有权限的人补）/ N 单=子公司（仅权限内、在管理子公司页可见） |
| 2 | 开单员工是否默认带 `create` | 静默建档=每个有开单权限的人都有，本人不知情；主动增删仍受权限控制 |
| 3 | 疑似重复时单据能否继续 | 能 |
| 4 | 阈值 | 按设计默认 |
| 5 | 合并权限 | 拆开：新增第 9 个动作 `merge` |
| 6 | 同名不同规格商品 | 必提示 |
