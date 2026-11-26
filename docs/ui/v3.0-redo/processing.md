# 加工单 B · v3.0 重做记录（#431 第一批第 2 页）

- 页面：`/processing-orders` → `apps/web/src/pages/processing/ProcessingOrdersPage.tsx`
- 稿子：`design/v3.0/index.html#processing-orders`（`DOC['processing-orders']`，L804）
- 截图（1440×1000 同宽）：`docs/ui/v3.0-redo/processing-{before,after,proto}.png`
- 机器验收：`node tools/ui-parity/check.mjs 加工单` → PASS

## 与采购单 A 同构的改动

页头 `.ph` + 一行原文说明、`+ 新建加工单`、工具栏「搜索框 → 状态统计片 → 看谁的」、
9 列表头、整行点进详情、行内不再放按钮、页脚「共 N 条」。样式直接复用 `app-v30.css` §9，
本页只需要把结构改成稿子的写法。

## 本页特有的两处

1. **数量列取「投入量」**：稿子的 `数量` 是 `o.qty`；B 单有「投入 → 可售」两个数，
   列表按稿子只留 `数量`（= `inputQty`），可售量在详情面板里看。原来那列叫「投入 → 可售」。
2. **统计片没有条数**：B 单列表走游标分页（`PageQuerySchema`），响应没有 `total`、
   也没有分组计数，所以只画状态名不画数字 —— 画本页的数会被读成全量。
   采购单是页码模式（`D95` 试点），那边有 `total` 时才画条数。

## 有意差异

与采购单一致：`导出 CSV` 不画（B 单后端无导出端点、且属 #425 本期不接）、
`全部经手人` 不画（列表契约无 `handlerId`）、外壳 / 按钮圆角 / 徽标尺寸属全站口径。
