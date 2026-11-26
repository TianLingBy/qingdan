# 库存数量页 v3.0 视觉证据

对应 issue：#433「第三批：库存 3 页按 v3.0 实现」中的库存数量页。

| 文件                        | 说明                                      |
| --------------------------- | ----------------------------------------- |
| `inventory-before.png`      | 最新 `origin/main`（`cab89d2`）的改前页面 |
| `inventory-after-light.png` | 改后亮色主题                              |
| `inventory-after-dark.png`  | 改后暗色主题                              |
| `inventory-detail-after-light.png` | 批次详情改后亮色主题               |
| `inventory-detail-after-dark.png`  | 批次详情改后暗色主题               |

截图使用同一组 4 个批次、2 个可见公司的静态真实结构数据，在 1440×1000 视口生成。
截图只用于版式验收，不代表生产数据。

批次详情两张图由真实 `InventoryPage` + `BatchDetail` 组件渲染，输入为冻结契约结构，
并在截图环境中关闭入场动画；用于验收详情网格、待执行占用来源和成本更正面板的
v3.0 语义类收口。
