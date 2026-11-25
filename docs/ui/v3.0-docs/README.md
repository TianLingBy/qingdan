# 单据四页（B / E / N / C）· v3.0 列表页脚（#431 第一批）

- 目标稿：`design/v3.0/index.html` 的 `DOC` 表 + `orderTable()` + `tableCard()`（四页共用同一套列表骨架）
- 规范口径：`docs/ui/frontend-change-rules.md`（v3.0，2026-11-24 修订）
- 依赖：`components/ListPager.tsx`（PR #455 引入，本 PR 加 `BatchPager`）

## 每页改了什么

四页都是「`card` + Tailwind `overflow-x-auto` + 页脚 `.pager`」，统一换成
`card list-card` + `.tw` + `.tf`：

| 页 | 分页契约 | 页脚现在长什么样 |
| --- | --- | --- |
| 加工单 B `/processing-orders` | `PageQuerySchema`（只有 cursor/limit） | 左「共 N 条」，右 `‹ 第 M 批 ›`（`BatchPager`） |
| 销售单 E `/sales-orders` | `PageableSchema`（page/pageSize/sort） | 左「共 N 张（· 合计）」，右首/上/页码/下/末 + 10/20/50 条每页 |
| 内部交易单 N `/internal-trades` | `PageQuerySchema` | 左「共 N 条」，右 `‹ 第 M 批 ›`（单批时不画） |
| 结算单 C `/settlements` | `PageQuerySchema` | 同上 |

**为什么 B / N / C 不画页码**：这三页的列表契约只有 `cursor` / `limit`，没有 `total`。
页码只能靠「本批行数」猜，算出来永远是 1 页——那就是一排点不动的死按钮。
所以只给「上一批 / 下一批」并写明是第几批；等 D95 的 `page/pageSize` 铺到这三个模块，
换成 `ListPager` 即可（组件已经在了）。

## 合计口径（销售 E）

只在「一页装得下全部」（`rows.length >= total`）时给合计，翻页态只写条数：
后端列表不回「全部筛选结果的金额汇总」，拿本页之和标「合计」翻一页就变数。
无 `sales.view_price` 时后端根本不回 `totalAmount`（D79），前端再按 `canViewPrice` 兜一道。

## 实测（真后端 PGlite + 真前端 + 无头 Chrome）

| 页 | 行数 | 页脚文案 | 翻页控件 | 表宽 / 容器宽 |
| --- | --- | --- | --- | --- |
| 加工 B | 4 | 共 4 条 | 上一批 / 下一批（首批两侧禁用） | 1150 / 1150 |
| 销售 E | 5 | 共 5 张 · 合计 ¥1,801.00 | 首/上/1/下/末 + 20 条/页 | 1150 / 1150 |
| 内贸 N | 5 | 共 5 条 | 单批不画 | 1150 / 1150 |
| 结算 C | 4 | 共 4 条 | 单批不画 | 1150 / 1150 |

四页 `table.scrollWidth === .tw.scrollWidth === 1150`，无横向滚动。

## 关于暗色截图

这次**没有**给暗色截图，原因不是偷懒：当前外壳（`shell` / `topbar` / 侧栏）是 Tailwind 浅色写死的，
`main.tsx` 又把 `data-mode` 固定为 `light`。把 token 切成暗色后，页面容器仍是白底，
而文字颜色跟着 token 变浅——截图会是一版「白底浅字」的坏样子，贴出来只会误导。
真要验暗色，得先有主题开关（改 `main.tsx` 一处 + 外壳吃 token），那是独立一单。

## 截图（1440×1000）

`processing[-before].png` / `sales[-before].png` / `internal[-before].png` / `settlements[-before].png`：
改前（整页）；`*-footer[-before].png`：页脚 2 倍特写。同一批数据、同一视口。
