# 采购单 A · v3.0 实现（#431 第一批）

- 目标稿：`design/v3.0/index.html` 的 `PG['purchase-orders']`（`DOC` 表 + `orderTable()` + `tableCard()`）
- 规范口径：`docs/ui/frontend-change-rules.md`（v3.0，2026-11-24 修订）
- 本次范围：**列表卡片 + 页脚分页**（`list-card` / `.tw` / `.tf` / v3.0 `.pager` / 每页条数）

## 改了什么

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 列表容器 | `<div class="card" data-state>` + `overflow-x-auto` | `card list-card` + `.tw`（四态时页脚分页自动收起） |
| 页脚 | `.pager` 里塞「共 N 张 / 上一页 / 页码输入框 / 下一页」 | `.tf`：左「共 N 张（· 合计）」，右「首 / 上 / 页码 / 下 / 末 + N 条/页」 |
| 分页组件 | 每页各写一份，页码只能靠输入框跳 | 抽出 `apps/web/src/components/ListPager.tsx`（六页共用，>7 页折叠成 `1 … 4 5 6 … 12`） |
| 每页条数 | 写死 20 | 页脚可选 10 / 20 / 50，改条数回第 1 页 |
| 合计 | 无 | 仅当「一页装得下全部」（`rows.length >= total`）时给；后端没有全量金额汇总，翻页态不拿本页和冒充合计；无 `view_price` 时金额为 `null`，同样不画 |

## 顺手修掉的一个样式冲突

`app-v30.css` 里 `.tf .pager button{background:transparent}`（防暗色白底白字）与
`.pager button.on{background:var(--v30-accent-solid)}` 同权重、且写在后面，
把**当前页的实心底洗成了透明** —— 白字配白底，页码看不见。
改成 `:not(.on)` 后正常（实测 `getComputedStyle(button.on).backgroundColor = rgb(20,22,26)`）。
另外给 `.tf .pager` 补 `padding:0`，否则 `.pager` 自带的内边距叠在 `.tf` 的 padding 上形成两级缩进。

## 实测（真后端 PGlite + 真前端 + 无头 Chrome，29 张单）

| 操作 | 结果 |
| --- | --- |
| 首屏 | 20 行 / 页码 1 高亮 / 共 29 张 / 2 页 / 上一页禁用 |
| 点「下一页」 | 9 行 / 页码 2 高亮 / 下一页禁用 |
| 选「50 条/页」 | 29 行 / 页码收成 1 / 出现「· 合计 ¥9,715.00」 |
| 宽度 | `table.scrollWidth === .tw.clientWidth === 1135`，无横向滚动 |

## 截图（1440×1000）

- `purchase-before.png` / `purchase-before-footer.png`：改前（v0.13 页码条）
- `purchase-after-light.png`：改后亮色（**没有暗色图**：外壳是 Tailwind 浅色写死、`main.tsx` 固定 `data-mode="light"`，切暗色会出现「白底浅字」，见 `docs/ui/v3.0-docs/README.md`）
- `purchase-footer-light.png` / `purchase-footer-zoom.png`：页脚与 2 倍特写

## 还没做（本页后续 PR）

- 开单表单的输入联想（`SuggestHint`，商品 / 供应商）——属于 #431 必做点 7，和其余四页一起接。
- 「共 N 条 · 合计」的全量口径要后端给聚合字段（`totalAmount` 汇总），属冻结清单外，未画。
