# 主数据「开单即建档」与相似度审核合并

最近更新：2026-11-16 ｜ 需求提出：负责人 ｜ 状态：待拍板（§十）

## 一、要解决的现状问题

**现状是「先建档，才能开单」**，与业务实际相反：业务员是先接到单，再补资料。

| 事实（源码为准） | 位置 | 后果 |
|---|---|---|
| `sales_order.customer_id uuid NOT NULL REFERENCES customer (id) ON DELETE RESTRICT` | `apps/api/migrations/0013_sales_orders.sql:29` | 必须先有客户才能存销售单 |
| `sales_order_line.product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT` | `apps/api/migrations/0013_sales_orders.sql:56` | 必须先有商品才能填行 |
| `purchase_order.supplier_id uuid NOT NULL REFERENCES supplier (id)` | `apps/api/migrations/0010_purchase_orders.sql:35` | 采购单同理 |
| `customer` 无任何唯一约束，只有 `(tenant_id, company_id, name)` 普通索引 | `0005_masterdata_customer.sql:38` | 同一客户可被重复录入十次，谁也没拦住 |
| `product` 无唯一约束，`aliases text[]` 用于检索但没人维护 | `0004_masterdata_product.sql:22-38` | 同物异名各录一条，库存与售价口径分裂 |
| 列表接口已支持 `keyword`（ILIKE 名称/联系人/电话） | `packages/contracts/src/customers.ts:44-50`、`apps/api/src/modules/masterdata/repo-customers.ts:157-160` | 联想**已有基础**，缺的是轻量 suggest 与「就地新建」 |
| 无 `pg_trgm` 扩展（迁移里从未 `CREATE EXTENSION`） | 全仓 `apps/api/migrations/*.sql` | 相似度只能应用层算，不能靠数据库索引 |

**结论**：缺的不是「能力」而是「顺序」。把建档挪到开单流程里，同时补三道闸：就地新建、保存即建档、相似度审核。

## 二、目标交互（员工视角）

1. **打字即联想**：开单页的客户/供应商/商品输入框，输入 2 个字符起调 suggest，返回 `[{id, 名称, 编号, 电话/规格}]`，回车或点选即填入；选中后带出默认值（客户→账期；商品→单位、默认售价）。
2. **联想里没有就新建**：下拉底部固定「+ 新建客户：<当前输入>」，点开是一个 4 字段内联小表单（名称必填，联系人、电话、账期选填），**不必离开单据页**。
3. **保存单据 = 建档完成**：内联新建的对象随单据一起提交，后端在同一事务里先建主数据再建单据；任一失败整体回滚，不留孤儿主数据。
4. **疑似重复不打断开单**：后端发现相似度超阈值时，**照样建档、照样存单**，只是给这条主数据打「疑似重复」标记并进审核队列；员工侧只看到一行提示「已建为客户「张三」，与「张三丰」相似，已提交审核」。
5. **由有权限的人收口**：主数据审核台列出「疑似重复」，逐条可选「合并到另一条」（改所有单据的引用、停用被并方）或「确认独立」（打标放行），全程审计。

## 三、数据模型改动（一个迁移文件）

迁移名：`apps/api/migrations/<14 位时间戳>_masterdata_autocreate.sql`（按 D92，见 §七）

```sql
-- 1. 三类主数据各加「建档来源」与「去重状态」
ALTER TABLE customer  ADD COLUMN origin text NOT NULL DEFAULT '后台录入'
  CHECK (origin IN ('后台录入','开单自动建档'));
ALTER TABLE customer  ADD COLUMN dedupe_state text NOT NULL DEFAULT '正常'
  CHECK (dedupe_state IN ('正常','疑似重复','已确认独立'));
-- supplier / product 同款两列（product.origin 只允许 后台录入/开单自动建档）

-- 2. 审核队列（一实体一行，合并后置 resolved）
CREATE TABLE masterdata_dedupe (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  entity text NOT NULL CHECK (entity IN ('customer','supplier','product')),
  entity_id uuid NOT NULL,            -- 新录入的那条（疑似方）
  candidate_id uuid NOT NULL,          -- 命中的既有那条（保留方候选）
  score numeric(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  matched_by text NOT NULL,            -- 命中依据：name_phone / name_only / alias / spec
  state text NOT NULL DEFAULT '待审' CHECK (state IN ('待审','已合并','已确认独立')),
  resolved_by uuid REFERENCES employee (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT masterdata_dedupe_pair_key UNIQUE (entity, entity_id, candidate_id)
);
CREATE INDEX masterdata_dedupe_pending_idx
  ON masterdata_dedupe (tenant_id, company_id, state, created_at DESC);
```

不合并不删行：合并后被并方 `status='停用'` + `dedupe_state='正常'`，历史单据引用改为保留方 id，审计留痕。**不物理删除任何主数据**（`ON DELETE RESTRICT` 本来就删不掉）。

## 四、相似度怎么算（应用层，无 pg_trgm）

**判定顺序**（命中即停，写 `matched_by`）：

| 顺序 | 依据 | 阈值 | matched_by |
|---|---|---|---|
| 1 | 同公司内「电话相同」（客户/供应商，仅数字比较） | 完全相同即 1.0 | `name_phone` |
| 2 | 名称规范化后完全相同（去空格、全半角统一、去「有限公司/公司/店」等后缀、小写） | 1.0 | `name_only` |
| 3 | 名称 trigram Jaccard ≥ 0.85 | 0.85–1.0 | `name_only` |
| 4 | 商品：名称 trigram ≥ 0.7 **且** 规格规范化后相同，或命中 `aliases` 任一项 | 0.7–1.0 | `alias` / `spec` |

- trigram：对规范化名称取 3 字符滑动窗口集合（含首尾边界符），`score = |A∩B| / |A∪B|`。纯 JS，几十行，无依赖（§十三 不重复造轮子——仓库里没有现成实现，这是最小自带）。
- 比较范围：同 `tenant_id + company_id` 内、`status='启用'`、最多取 500 条候选（按名称前缀 + trigram 粗筛，避免全表扫，符合 §七 性能标尺）。
- 阈值集中在一个常量文件 `apps/api/src/modules/masterdata/dedupe/thresholds.ts`，便于以后按品类调。

## 五、审核台与合并语义

| 操作 | 端点 | 权限 | 语义 |
|---|---|---|---|
| 待审列表 | `GET /api/v1/masterdata/dedupe?entity=&state=待审` | 对应域 `read` | 分页，按 score 降序 |
| 合并 | `POST /api/v1/masterdata/dedupe/{id}/merge` body `{keepId, mergeId}` | 对应域 **`update`** | 见下 |
| 确认独立 | `POST /api/v1/masterdata/dedupe/{id}/keep-separate` | 对应域 **`update`** | `dedupe_state='已确认独立'`，队列 `已确认独立` |

合并要做的事（单事务，顺序固定）：
1. 校验两条同公司、同实体、都未停用；`keepId` 不允许是被并方引用过的单据方（有则先切引用序）；
2. 把引用 `mergeId` 的单据全部改指 `keepId`：`sales_order.customer_id`、`customer_return.customer_id`、`purchase_order.supplier_id`、`supplier_return.supplier_id`、各单据行的 `product_id`（含 `sales_order_line`/`purchase_order_line`/`stocktake_line`/`internal_trade_line` 等，逐个列出，用 `UPDATE … WHERE x_id = mergeId`）；
3. 空字段合并：`keepId` 上为 null 而 `mergeId` 有值的（电话/联系人/账期/规格/默认售价/aliases）补过去；`aliases` 取并集；
4. `mergeId`：`status='停用'`、`version+1`；
5. 队列行 `state='已合并'`、写 `resolved_by/resolved_at`；
6. 审计两条：`customer.merge`（含 keepId/mergeId/影响行数）、被并方的 update 审计。

**权限口径说明（重要）**：合并复用 `update` 而不是新增第 9 个动作 —— `packages/contracts/src/domains.ts` 的 8 个动作是红线，且「合并 = 修改主数据」语义成立。代价是：**能改客户的人就能合并客户**，若业务上要拆开（只让主管合并），必须新增动作（红线，需负责人拍板，见 §十⑤）。

## 六、权限与安全四类

**权限点（不写角色判断，一律 `allowsScope`）**
- 开单页联想：`customer.read` / `supplier.read` / `product.read`
- 内联新建：`customer.create` / `supplier.create` / `product.create`（**这是本设计最大的口径变化**：以前业务员不需要 create，现在要；见 §十①）
- 审核台与合并：对应域 `update`
- 无 `create` 的员工：下拉只显示「搜索」，不显示「新建」，保存时若带 draft 由后端 403 并给出缺哪个权限点

**安全四底线自查**
- 用户安全：内联新建只写当前登录人可见公司的数据（`company_id` 取单据的公司，不取前端传值）；合并必须二次确认（`If-Match` + 请求体回显两条名称）；不误伤：只停用不删除、全量可回滚（把 `status` 改回即可，引用已切走）。
- 数据安全：一个迁移单文件单事务；新列全有默认值、不 backfill；`masterdata_dedupe` 含 `tenant_id + company_id`（RLS 口径同其它表），审核操作记审计（D51）。
- 产品安全：疑似重复**不阻塞**单据保存（否则业务停摆）；合并影响行数在响应里返回，前端必须展示；同字段口径一致（`dedupe_state` 只有三个值，前端不另造字符串）。
- 服务器安全：无新依赖、无外部调用；相似度计算纯内存，候选上限 500 条防内存放大；`dedupe` 表查询走 `(tenant_id, company_id, state, created_at)` 复合索引。

## 七、一期改动清单

| # | 改动 | 文件 | 红线 |
|---|---|---|---|
| 1 | 迁移（6 列 + 1 表 + 1 索引） | `apps/api/migrations/<ts>_masterdata_autocreate.sql` | ✅ 迁移 |
| 2 | 契约：suggest 三端点 + 单据保存支持 draft + dedupe 三端点 | `packages/contracts/src/customers.ts`、`suppliers.ts`、`products.ts`、`masterdata-dedupe.ts`（新建） | ✅ 契约 |
| 3 | 相似度实现 | `apps/api/src/modules/masterdata/dedupe/{normalize,trigram,thresholds}.ts` | — |
| 4 | 保存即建档 | `apps/api/src/modules/sales/usecases/*`、`purchase/*`、`internal-trade/*`（各自 `resolveCustomer/resolveProduct` 前置） | — |
| 5 | 审核台用例 | `apps/api/src/modules/masterdata/usecases/dedupe.ts` | — |
| 6 | 前端联想组件 | `apps/web/src/components/EntityPicker.tsx`（新建）+ 各开单页接入 | — |
| 7 | 审核台页面 | `apps/web/src/pages/masterdata/dedupe/**` | — |
| 8 | 决策记录 | `docs/decisions.md` 新增 **D92**（开单即建档 + 疑似重复不阻塞 + 合并复用 update） | ✅ decisions |
| 9 | 编号 | 迁移用 14 位时间戳前缀，跑 `node tools/check-numbering.mjs --base origin/main` | — |

端点（全部登记进契约，`operationId` 前缀沿用现有风格）：

| operationId | 方法与路径 | 说明 |
|---|---|---|
| `customer.suggest` | `GET /api/v1/customers/suggest?q=&companyId=&limit=20` | 只回 `id/name/customer_no/contact_phone/credit_term_days` |
| `supplier.suggest` | `GET /api/v1/suppliers/suggest?q=&companyId=` | 同上 |
| `product.suggest` | `GET /api/v1/products/suggest?q=&companyId=` | 回 `id/name/product_no/specification/unit/default_sale_price`，匹配 `name` 与 `aliases` |
| `masterdata.dedupe.list` | `GET /api/v1/masterdata/dedupe` | 待审列表 |
| `masterdata.dedupe.merge` | `POST /api/v1/masterdata/dedupe/{id}/merge` | 合并 |
| `masterdata.dedupe.keepSeparate` | `POST /api/v1/masterdata/dedupe/{id}/keep-separate` | 确认独立 |

单据保存的入参扩展（向后兼容）：`customerId` 与 `customerDraft` 二选一，同时传 422；`lines[].productId` 与 `lines[].productDraft` 二选一。

## 八、验收命令

```
node tools/check-numbering.mjs --base origin/main    # 必须 [ok]
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests/run.ps1
```

用例必须覆盖：
1. 无 `customer.create` 的账号带 draft 保存单据 → 403，且**单据与主数据都没落库**（事务回滚）；
2. 正常 draft → 客户建成 `origin='开单自动建档'`、单据 `customer_id` 指向新客户；
3. 同名客户二次录入 → 单据保存成功 + 客户建成功 + `dedupe_state='疑似重复'` + 队列一条 `score=1.0 matched_by=name_only`；
4. 电话相同但名字不同 → 命中 `name_phone`，score 1.0；
5. 商品别名命中 → `matched_by='alias'`；
6. 合并：两张销售单分别引用 A、B，把 B 并入 A → 两单都指向 A、B `status='停用'`、队列 `已合并`、审计两条；
7. 合并跨公司 → 403/422；合并自己 → 422；
8. 确认独立 → `dedupe_state='已确认独立'`，再次录入同名不再进队列（队列唯一键 + 已确认状态过滤）。

## 九、明确不做（一期）

- **不做模糊搜索的数据库索引优化**（无 `pg_trgm`；一期在 500 条候选内算，量级上来再谈扩展，需要单独一条决策）
- **不做自动合并**（阈值再高也要人点头；自动合并错了就是账目错乱）
- **不做跨公司查重**（`company_id` 隔离是 D15 铁律，同一客户在两公司各存一条是合法的）
- **不做主数据历史版本对比**（合并只保留审计，不做 diff 页）
- **不给供应商做「开单自动建档」以外的批量导入**（导入是独立需求）

## 十、待负责人拍板

1. **开单员工是否默认获得 `customer.create` / `supplier.create` / `product.create`**：我建议给「业务员/单证」这类岗位的预设加上这三个动作（预设只是默认值，可撤销）。不给的话，自动建档会 403，等于本需求白做。代价：预设变更要写进 D92，且权限页会多三个勾。
2. **疑似重复时单据是否继续流转**：我建议继续（否则业务停摆）。代价：会出现「待审客户已经出了单」，需要审核人尽快收口。
3. **相似度阈值**：名称 trigram ≥0.85（客户/供应商）、商品 0.7 + 规格相同。我建议先按这个上线，把阈值放常量文件里便于调。代价：阈值偏低会审得多，偏高会漏。
4. **合并动作权限**：复用 `update`（我推荐，不动红线）还是新增第 9 个动作 `merge`（要改 `domains.ts` + `decisions.md`，以后能拆开「能改」与「能合并」）。代价分别是「能改的人都能合并」和「一次红线改动」。
5. **商品同名不同规格**：我按「名称相似 + 规格不同 = 不同商品，不提示」处理，只有规格也相同或别名命中才提示。若业务上「同名必提示」，我改成名称命中即提示。
