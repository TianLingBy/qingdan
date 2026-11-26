# 详情与表单换皮：样式底座 + 结算单 C 样板（#431 补单）

负责人 2026-11-25 在 #431 的验收：**第一批只把列表区换成了 v3.0，点进一张单之后还是旧 UI**。
这一单补的就是「点进去之后的那半边」，先落一套**六页共用**的样式底座，再拿结算单 C 做样板。

## 一句话结论

结算单详情面板里，改前 **88 处 Tailwind 类 + 22 处内联 style**，改后 **0 + 0**，
截图逐像素对得上（同一批数据、同一个 1440 视口）。

| | 改前 | 改后 |
|---|---|---|
| 详情面板容器 | `card space-y-4 p-5` | `card detail` |
| 单据信息网格 | `dl.grid.gap-px.rounded-xl` + `style={{gridTemplateColumns}}` | `dl[data-cols="3"]` |
| 提成块 | `section.rounded-xl.border.border-slate-200.p-3` + 内部散装 `dl` | `form-sec` + `form-sec-h` + `form-sec-b` + `dl[data-cols="3"]` |
| 金额 / 说明 | `text-xs text-slate-500` / `text-slate-400` | `detail-why` / `cell-muted` |
| 提示条 | `rounded-xl border border-amber-200 bg-amber-50 …` | `alert alert-warn` / `alert alert-bad` |
| 表格单号入口 | `font-mono text-xs text-slate-900 hover:underline` | `doc-link` |
| 行内按钮 | `rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-700` | `btn btn-row` |
| 页面根容器 | `mx-auto max-w-7xl space-y-5` | `page-body` |

改前图里提成块的三个字段是**平铺**的（标签在上、值在下，没有分隔线、没有底色），
改后是 `.dl` 网格（单元格底色 + 1px 分隔线），与上方「单据信息」同一套版式。

## 底座新增了什么（`app-v30.css` §8）

按 `design/v3.0/index.html` 的类名搬，token 桥到 `--v30-*`：

| 类 | 稿子 | 用途 |
|---|---|---|
| `.detail` / `.detail-head` / `.detail-title` / `.detail-tools` / `.detail-meta` / `.detail-dot` | — | 详情面板骨架（替代 `card + space-y-* + p-*`） |
| `.detail-acts` / `.detail-why` | — | 动作区与禁用原因 |
| `.dl`（`data-cols="2\|3\|4"`） | L304–307 | 单据信息 / 提成网格 |
| `.ln` / `.ln td.nm` / `.ln-note` / `.ln-sum` | L309–317 | 行明细紧凑表 |
| `.form-sec` / `.form-sec-h` / `.form-sec-b` / `.form-note` / `.form-empty` | — | 表单分区块 |
| `.fm`（`.c3` / `.c4` / `.w`） | L353–357 | 字段网格 |
| `.ipt` | — | 零散单行输入 |
| `.sum-bar` | — | 货款 / 费用 / 合计条 |
| `.alert`（`-bad` / `-warn` / `-info` / `-sm`） | — | 提示块三档 |
| `.mask` / `.mask-scroll` / `.sheet`（`-h` / `-b` / `-f` / `-close`） | L288–290 | 宽弹层（发货 / 撤销） |
| `.modal` | L350–359 | 窄确认框 |
| `.page-body` / `.cell-muted` / `.cell-strong` / `.sel` / `.toolbar-end` / `.doc-link` / `.row-acts` / `.btn-row` | — | 页面根容器与表格小件 |

新增变量（`--v30-` 前缀，不动既有 token）：`--v30-bad-10/30`、`--v30-warn`、`--v30-warn-10/30`。
tokens-v013 只有实心 `--danger` / `--danger-on-surface`，没有 alpha 变体，提示块要「淡底实字」。

**没搬**：`.tl`（时间线：审计日志没有按单据过滤的参数，画出来是假数据）、
`.drawer`（本仓详情是页内面板不是抽屉，改交互不属换皮）、`.act` / `.act-g`（宫格动作，
本仓动作区是 `btn` 一排，`btn` 家族已在 v0.13 定稿）。

## 共享组件一起改了（六页一次覆盖）

`OrderDetailUI.tsx` 是六张单据共用的三块版式，这一单把它内部也换掉了：

- `DetailHead`：`space-y-2` / `flex … gap-3` / `ml-auto` / `text-lg` → `detail-*` 一族；
- `DocMeta`：`gap-px` + **内联 `style={{gridTemplateColumns}}`** → `dl[data-cols]`
  （内联样式不参与媒体查询，窄屏会硬撑成 4 列把格子挤成一条线）；
- `LinesFooter`：`px-4 py-3 text-xs` + 内联 border → `ln-note` / `ln-sum`。

## 顺手修的两个既有问题

1. **`BatchPager` 的 `label` 传错**：`SettlementsPage` 给它传的是字面量 `label="{label}"`，
   屏读器念到的是「左花括号 label 右花括号」。改成「结算单分批翻页」。
2. **C 单 10 列被顶出卡片**：改前列表底部有一条横向滚动条、「操作」列裁掉半截。
   换成 `.tw.tight`（稿子给列多的表准备的紧凑内边距）后
   `table.scrollWidth === .tw.scrollWidth === 1119`，10 列全见。

## 实测（真后端 + 真前端 + 无头 Chrome，1440×1000）

- 详情面板：`class="card detail"`、`.dl[data-cols="3"]`、`.form-sec` 存在；
  **Tailwind 类 0 处、内联 style 0 处**（脚本逐条数出来，见 `.tmp/e2e-v013/shoot-settlement-detail.mjs`）；
- 面板 `clientWidth === scrollWidth === 1135`，无横向溢出；
- 列表 10 列 `scrollWidth === 1119`，无横向滚动。

## 必须保留的 Tailwind（PR 判据的例外）

| 位置 | 类 | 为什么留 |
|---|---|---|
| 列表 / 详情表 | `min-w-[1060px]` / `min-w-[560px]` | 表格最小宽度是**布局参数**（横向滚动阈值），不是装饰；换成语义类得给每张表开一个类名，反而更难读 |
| 列表 / 详情表 | `w-full` / `whitespace-nowrap` / `text-right` | 同上，列宽与对齐 |
| `OrderDetailUI` | — | 已无 |

## 还没做的（下一单）

| 页 | 状态 | 等什么 |
|---|---|---|
| 内贸 N | 已完成（`internal.md`） | — |
| 采购 A | 已完成（`purchase.md`） | — |
| 加工 B | 已完成（`processing.md`） | — |
| 销售 E | 已完成（`sales.md`） | — |
| 冲正 R / S / I | 排队 | #459（冲正列表卡）等评审 |

五页都按这一单的类映射改，不再新增底座类；真缺了再加，并在这里补表。

第五轮（销售 E）补进底座的只有五件：`.chip-x` / `.chip-static` / `.text-warn` / `.text-bad`
（批次 chip 与句内染色）、`.qr-box` / `.qr-empty` / `.qr-row` / `.qr-meta`（扫码收款面板）、
`.ln tr.vtop td`（表单明细行靠顶对齐）。
