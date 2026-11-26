# 库存流水页 v3.0 视觉证据

对应 issue：#433「第三批：库存 3 页按 v3.0 实现」中的库存流水页。

| 文件                              | 说明                                      |
| --------------------------------- | ----------------------------------------- |
| `inventory-flows-before.png`      | 最新 `origin/main`（`cab89d2`）的改前页面 |
| `inventory-flows-after-light.png` | 改后亮色主题                              |
| `inventory-flows-after-dark.png`  | 改后暗色主题                              |
| `inventory-flows-refined-after-light.png` | 语义类收口后亮色主题              |
| `inventory-flows-refined-after-dark.png`  | 语义类收口后暗色主题              |

截图为 1440×1000 视口，使用同一组真实契约结构数据；仅用于版式验收，不代表生产数据。

`*-refined-after-*` 由真实 `InventoryFlowsPage` 渲染，用于确认页面从 Tailwind
工具类迁移到 `.page-stack / .page-chips / .data-table / .tf` 后，字段边界、表头和
游标分页仍与冻结契约一致。
