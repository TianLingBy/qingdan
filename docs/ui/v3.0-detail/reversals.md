# 冲正 R / S / I：详情、开单表单与取消/驳回块换皮（#431 第六轮）

六页里的最后一页。它和前面五页不一样的地方：**一页三栏**（客户退货 R / 供应商退货 S /
盘点盈亏 I），每栏各带一张开单表单、一个详情面板，但三栏的版式是同一套 —— 所以这一轮
把公共部分收进 `reversals-ui.tsx`，三栏只留业务字段。

## 一句话结论

三栏的六个区域（3 张开单表单 + 3 个详情面板），改前 **108 / 83 / 64 + 8 / 11 / 7 处
Tailwind 类**、**7 处内联 style**，改后全部 **0 + 0**，六块 `clientWidth === scrollWidth`。
四态行、禁用原因与服务端原话一个字没改。

## 前后对照（三栏共用一张表）

| | 改前 | 改后 |
|---|---|---|
| 分栏根容器 | `space-y-3` | `panel-stack` |
| 开单表单外壳 | `card space-y-3 p-4` | `form-card` |
| 表单标题 | `h3.text-sm.font-semibold.text-slate-900` | `form-head` > `h2`（右侧口径说明走 `detail-why`） |
| 字段网格 | `grid gap-3 sm:grid-cols-2` / `sm:grid-cols-3` | `fm` / `fm c3` |
| 单个字段 | `label.block.text-sm` + `span.text-[var(--text-2)]` + `span.mt-1.block.text-[11px]` | `fm-field`（`> span` 标签、`> small` 提示） |
| 输入控件 | `mt-1 w-full rounded-lg border border-[var(--line-2)] …` | `ipt` |
| 明细行卡 | `div.rounded-lg.border.border-slate-200.p-3` | `line-card` |
| 行内五列 | `grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto]` | `fm lines` |
| 行内金额 | `div.self-end.pb-2.text-xs.text-slate-500` | `line-amount` |
| 行内「删除」 | `mt-5 h-9 self-start … rounded-lg border border-slate-300 …` | `btn btn-row` |
| 批次块 | `div.mt-2` + `span.text-[11px]` + `div.mt-1.flex.flex-wrap.gap-1.5` | `line-batches` > `span` + `chip-row` |
| 批次 chip | `rounded-full border px-2 py-0.5 text-[11px]` + 两套写死色 | `chip` / `chip on` |
| 无批次提示 | `span.text-[11px].text-slate-400` | `chip-none` |
| 「+ 加一行商品」 | `btn btn-s`（被纵向 flex 拉满） | `btn form-add` |
| 提交 / 取消 | `div.flex.gap-2` | `detail-acts` |
| 校验错误 | `ul.rounded-lg.border-amber-200.bg-amber-50…` | `alert alert-warn alert-sm` > `ul` |
| 请求错误 | `div.rounded-lg.border-rose-200.bg-rose-50…` | `alert alert-bad alert-sm` > `alert-row` |
| 口径说明条 | `p.rounded-lg.bg-[var(--surf-2)].px-3.py-2.text-xs` | `alert alert-info alert-sm` |
| 筛选下拉 | `rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm` | `sel` |
| 工具条右侧建单按钮 | `btn btn-primary ml-auto` | `btn btn-primary act-end` |
| 页面根容器 | `mx-auto max-w-6xl space-y-4` | `page-body` |
| 列表单号 | `font-mono text-xs underline-offset-2 hover:underline` | `doc-link` |
| 列表行内按钮 | `btn btn-s` | `btn btn-row`（外套 `row-acts`） |
| 列表副列 | `font-mono text-xs` + `style={{color:'var(--text-3)'}}` | `mono cell-muted` |
| 详情面板 | `card min-w-0 p-4` | `card detail` |
| 详情内层 | `div.space-y-3`（容器已有 12px gap，再套一层） | 直接铺进 `.detail` |
| 明细表 | `div.overflow-x-auto` + `table.w-full.text-left` + `style={{minWidth}}` | `div.ln` + `<table>` |
| 表内批次 | `font-mono text-xs` + 内联色 | `mono cell-muted` |
| 结尾说明 | `p.text-xs.leading-relaxed` + 内联色 | `detail-why` |
| 无商品明细 | `p.rounded-lg.px-3.py-2.text-xs` + 内联底色 | `alert alert-info alert-sm` |

## 三栏各自的差异（不是漏画，是业务不同）

- **R 客户退货**：两型（退货退款 / 仅退款），所以字段网格是 2 列并在「仅退款」时才多出
  「仅退款类型」；明细行卡带批次 chip（一行可引多个批次，D22）。
- **S 供应商退货**：只退钱。字段只有两个（原采购单 / 应退金额），明细同样带批次；
  详情多一块**取消**（`supplier_return.delete`）—— 改成 `alert alert-bad` 套
  `reason-field` + `ipt`，与采购单「撤销发货」完全同形。
- **I 盘点盈亏**：没有商品明细，只有一行「差异量 / 方向 / 权限要求」的汇总条，
  改成 `alert alert-info alert-sm` 一句话（原来是一条 `gap-x-5` 的 flex 条，暗色下
  分不清哪句是提示哪句是数据）。审批段有「批准 / 驳回」，驳回块改成
  `alert alert-bad` + `reason-field`，批准成功的结果条改成 `.alert-ok`。

## 这一轮补进底座的五件（`app-v30.css` §8.7 / §8.13）

| 类 | 用途 |
|---|---|
| `.fm-field` | 单个字段的竖排（标签 / 控件 / 提示）。`.fm` 只管分列，备注、取消原因这类独占一行的字段原来各写一套 `label.block.text-sm` |
| `.alert-row` | 提示块里「一句话 + 一个重试按钮」。`detail-acts` 带 16px 上边距，会把一行提示撑成两行高 |
| `.alert-ok` | 第四档提示（审批通过 / 入账完成）。tokens-v013 里绿只有 `.st.ok` 那组值，没有 alpha 变体，所以照它的值单开 |
| `.panel-stack` | 分栏里的一摞块（说明条 → 工具条 → 列表 → 详情），等价于原来的 `space-y-3`；`.page-body` 带 max-width 与居中，是页面根专用的 |
| `.line-batches > span` | 批次块的小标题（11px / ink-3），原来写 `text-[11px] text-slate-500` |

## 实测（真后端 + 真前端 + 无头 Chrome，1440×1000，同数据同单）

脚本：`.tmp/e2e-v013/shoot-reversals-detail.mjs`（`before` / `after` 各跑一遍）。
区域定位**不绑类名**（改前 `section.card.space-y-3.p-4`、改后 `section.form-card`），
按「这栏特有的字」找元素，否则改前那一轮直接找不到。

| 区域 | Tailwind 改前 → 改后 | 内联 style | 溢出 |
|---|---|---|---|
| R 开单表单 | 108 → **0** | 0 → 0 | 无 |
| R 详情 | 8 → **0** | 2 → **0** | 无 |
| S 开单表单 | 83 → **0** | 0 → 0 | 无 |
| S 详情 | 11 → **0** | 3 → **0** | 无 |
| I 开单表单 | 64 → **0** | 0 → 0 | 无 |
| I 详情 | 7 → **0** | 2 → **0** | 无 |

文件级（`count-tailwind-reversals.mjs`，判据同 #431）：

| 文件 | 改前 | 改后 |
|---|---|---|
| `CustomerReturnsPanel.tsx` | 80 | **0** |
| `SupplierReturnsPanel.tsx` | 79 | **0** |
| `StocktakesPanel.tsx` | 80 | **0** |
| `reversals-ui.tsx` | 33 | **0** |
| `ReversalsPage.tsx` | 10 | **0** |

## 必须保留的 Tailwind（PR 判据的例外）

| 位置 | 类 | 为什么留 |
|---|---|---|
| 列表卡片（`reversals-ui.tsx`） | `w-full` / `text-left` / `min-w-[680px]`·`min-w-[620px]`·`min-w-[720px]` | 表宽、表头对齐与横向滚动阈值，与其余五页列表同一条口径（`app-v013.css` 的 `th` 只给了字色字重，对齐仍是 UA 的居中，`text-left` 省不掉） |
| 列表「操作」列表头 | `text-right` | 布局类（不在 #431 那条清单里）；其余页面用空表头 `<th />`，这三栏要写「操作」两个字，就得自己对齐 |

## 三个容易踩的坑

1. **`Kv` 是死代码**：`reversals-ui.tsx` 里导出的「键 → 值」小组件全仓没有调用点
   （三个详情都走 `DocMeta`）。换皮时直接删掉，留着只是又一处没人用的 Tailwind 残留。
2. **表单标题要用 `h2` 不是 `h3`**：`.form-head h2` 才有 16px / 600 的字号规则；
   写成 `h3` 就只剩 `form-head` 的基线对齐，标题看起来比正文还小。
3. **框选表格时不要把 `min-w-[…]` 一起改成内联 style**：详情里原来两张表都是
   `style={{minWidth:'520px'}}`，换成 `.ln` 后**不再需要**最小宽度 —— `.ln` 的 5 列
   在 1152 宽度下放得下，加回去反而会在窄屏多出一条横向滚动条。

## 与 #459 的关系

`feat/reversals-v30`（#459）做的是同一页的**列表卡与页脚**，它基于 `main`，
不含 #462 那套详情/表单底座（`app-v30.css` 里没有 `.ipt` / `.fm` / `.detail`）。
所以本分支是从详情链顶（`feat/detail-sales`）拉的，再把 #459 合进来当底座：

```
main
 └─ #462 → #463 → #465 → #467 → #468 ─┐
                                       ├─ feat/detail-reversals（本单）
         #459 ─────────────────────────┘   （merge，无冲突）
```

合入顺序：`#462 → #463 → #465 → #467 → #468 → 本单`。#459 可以先独立合进 main，
本分支那次 merge 届时变成空操作，不影响 diff。

## 还没做的

- **暗色截图**：仍要等「主题开关」（#431 待拍板项之一）。
- **权限 `title` 两套说法**：全仓待统一。
- **`.btn.btn-p` 没有主色**：`app-v013.css:98` 给它深底，同一文件 322 行的
  `.btn{background:var(--surf-1)}` 特异性相同、位置更靠后，压回白底 ——
  全仓 14 处 `btn btn-p`（含本页的「完成」「批准」「确认取消」）与普通描边按钮无区别。
  修法是一条 `.btn.btn-p{…}` 提特异性，属全局配色，留待拍板。
