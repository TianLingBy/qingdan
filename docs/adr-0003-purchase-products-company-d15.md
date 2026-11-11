# ADR-0003：采购单明细商品的公司归属校验（D15）

- 状态：已采纳（2026-11-11）
- 关联：`docs/AI-OPTIMIZATION-BRIEF.md` 阶段一（ESLint 清死码时暴露）；D15 数据隔离；Issue #185 同日验收
- 影响文件：`apps/api/src/modules/purchase/repo.ts`、`apps/api/src/modules/purchase/usecases/purchase-orders.test.ts`

## 背景

0010 的 `purchase_order_line.product_id` 只保证「商品存在」，不保证「商品属于采购单所在公司」。`repo.ts` 里原本写好了 `assertProductsInCompany`（去重后一次查询、报 `VALIDATION_FAILED`），**但全仓没有任何调用点**：

- 创建路径（`insertPurchaseOrder`）只校验了供应商与经手人；
- 修改路径（`updatePurchaseOrder`）只校验供应商与经手人，明细替换时直接 `DELETE` + 重新插入。

也就是说：只要知道别的公司的商品 UUID，就能把它写进自己公司的采购单。库存、成本、报表都按商品维度串联，这是一条实际的数据隔离缺口，不是风格问题。

（该函数之所以一直没被调用，是因为 ESLint 的 `no-unused-vars` 把它当死码报出来——清死码时才发现它从来没接上。）

## 决策

1. **保留单一校验函数**（`assertProductsInCompany`：入参 `productIds`、`companyId`，去重后一次 `SELECT id FROM product WHERE tenant_id=$1 AND company_id=$2 AND id = ANY($3)`，缺失的 id 一次性报出）。
2. **两条写入路径都接线**：
   - 创建：`insertPurchaseOrder` 在供应商/经手人校验之后、`INSERT` 之前校验全部明细商品；
   - 修改：`updatePurchaseOrder` 在**任何写入之前**（早于单头 UPDATE 与明细 DELETE）校验 `input.lines`。
3. **失败语义沿用 D15**：跨公司引用等同不存在，`VALIDATION_FAILED`（HTTP 422），details 带上缺失的 `productIds` 与 `companyId`；事务回滚，不留半张单。

## 为什么不放数据库

- 现有表结构没有 `(product_id, company_id)` 的复合外键可挂（`product` 的主键是 `id`，公司是其中一个属性）；加复合唯一键 + 复合外键要动 0010 与所有引用表，属于更大的迁移。
- 校验放在 repo 层是当前代码的既有分工（供应商公司校验也在这里），保持一致，改动面最小。

## 后果

- 好：跨公司商品在开单/改单时直接 422，且失败不落库（回归测试断言条数不变、版本不变）。
- 坏：**行为变更**——此前能通过的开单现在会被拒；如果线上已有跨公司引用（本仓尚无真实部署数据），需要先清洗，否则用户保存时会报错。
- 未做：不校验「商品状态是否启用」（D15 只管归属），不做历史数据修复脚本。
- 测试：`purchase-orders.test.ts` 新增用例覆盖「开单引用他公司商品 → 422 且单数不变」「改单换成他公司商品 → 422 且版本/明细不变」。
