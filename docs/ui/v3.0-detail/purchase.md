# 采购单 A：详情、开单表单与发货浮层换皮（#431 第三轮）

接 `README.md`（#462 的底座 + 结算单 C 样板）与 `internal.md`（#463 内贸 N）。
这一轮把**采购单 A** 的三块界面按同一套类换掉：详情面板、开单表单、发货弹层。
底座没有再新增结构性类，只补了 `.th-sort` 一个（可排序表头），另外修了 `.ln` 的两条继承问题（见下）。

采购 A 是这一轮里覆盖面最广的一页：详情 + **两段**表单（商品明细 / 费用明细）+ **一个浮层**（逐行选去向的发货）。
它换完，加工 B 与销售 E 只剩字段多少的差别。

## 判据实测（真后端 + 真前端 + 无头 Chrome，1440×1000）

| | 改前 | 改后 |
|---|---|---|
| `PurchaseOrdersPage.tsx` 内 Tailwind 类 | **385 处** | **0**（只剩 `min-w-[920px]`，见「必须保留」） |
| `ShipDialog.tsx` 内 Tailwind 类 | **87 处** | **0** |
| 详情面板内 Tailwind 类 / 内联 style | 11 处 / 3 处 | **0 / 0** |
| 撤销发货块内 Tailwind 类 | 31 处 | **0** |
| 开单表单内 Tailwind 类 | 142 处 | **0** |
| 发货弹层内 Tailwind 类 | 60 处 | **0** |
| 四块的 `clientWidth / scrollWidth` | — | 1135/1135、1093/1093、1135/1135、766/766（均无横向溢出） |

改前文件里数出来的类（前 10）：`px-4 ×22`、`py-2 ×18`、`text-sm ×17`、`text-xs ×14`、
`rounded-lg ×9`、`border-slate-300 ×8`、`text-slate-500 ×8`、`text-slate-600 ×7`、
`mt-1 ×6`、`rounded ×6`。

## 类映射（与 #462 / #463 同一张表，没有新口径）

| 位置 | 改前 | 改后 |
|---|---|---|
| 页面根容器 | `mx-auto max-w-7xl space-y-4` | `page-body` |
| 详情面板 | `card min-w-0 space-y-3 p-4` | `card detail` |
| 详情明细分（商品 / 费用两张表） | `overflow-x-auto` + `table style={{minWidth:'560px'}}` + `tr.r-row` | `.ln` + `<table>` |
| 行内金额单元格 | `num whitespace-nowrap` | `num`（`.ln td` 自带 nowrap） |
| 备注 / 物料 / 时间格 | `style={{color:'var(--text-3)'}}` / `text-slate-500` | `cell-muted` |
| 动作区 | `mt-4 flex flex-wrap items-center gap-3` | `detail-acts`（取消靠右 `act-end`） |
| 禁用原因 | `text-xs text-slate-500` | `detail-why` |
| 撤销发货块 | `rounded-lg border border-rose-200 bg-rose-50 p-3` | `alert alert-bad` + `reason-field` + `ipt` |
| 开单表单外壳 | `space-y-4 rounded-xl border … p-5 shadow-sm` | `form-card` |
| 表单标题行 | `flex flex-wrap items-center justify-between gap-2` | `form-head`（右侧改放单号口径说明） |
| 公司 / 供应商 / 经手人 | `grid gap-4 sm:grid-cols-3` + 逐字段 `mt-1 w-full rounded-lg border …` | `fm c3`（控件自带样式） |
| 经手人（只读） | `input readOnly` + `bg-slate-50 text-slate-600` | `<p class="fm-readonly">` |
| 新建供应商内联表单 | `mt-2 grid gap-3 rounded-lg border … p-3 sm:grid-cols-3` | `form-sec` + `form-sec-b fm c3`（说明行 `.w` 跨列） |
| 商品明细 | `overflow-x-auto` + `table min-w-[640px]` + `td.px-4.py-2` | `form-stack` + 每行 `line-card` + `.fm lines`（与内贸同一套） |
| 商品明细后缀说明 | `px-4 pb-3 text-xs text-slate-400` | `form-head` 右侧 `detail-why` |
| 费用明细 | `table min-w-[720px]` | `.ln` + `<table>`，输入用 `ipt` |
| 费用空态 | `px-4 py-3 text-sm text-slate-500` | `form-empty` |
| 合计条 | `flex flex-wrap gap-6 rounded-lg bg-slate-50 px-4 py-3 text-sm` | `sum-bar` |
| 校验错误 / 服务端错误 | `space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700` | `alert alert-bad alert-sm` |
| 提交按钮 | `rounded-lg bg-slate-900 px-4 py-2 … text-white` | `detail-acts` + `btn btn-primary`（取消从标题行挪到这里） |
| 列表单号入口 | `font-mono text-xs underline-offset-2 hover:underline` | `doc-link` |
| 列表行内按钮 | `btn btn-s` / `btn btn-s danger` | `btn btn-row` / `btn btn-row danger` |
| 列表动作槽 | `flex justify-end gap-1.5` | `row-acts` |
| 列表表头排序按钮 | `inline-flex items-center gap-1 font-medium hover:text-slate-900` + 箭头 `text-xs text-slate-400` | `th-sort` + `<i>` |
| 工具条下拉 | `rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm` | `sel` |
| 发货弹层 | `fixed inset-0 z-40 flex … bg-slate-900/40 p-4` + `rounded-xl … shadow-xl` | `mask-scroll` + `sheet`（`-h` / `-b` / `-f` 三段） |
| 发货弹层表格 | `table min-w-[620px]` + `td.py-2` | `.ln` + `<table>`，下拉 `ipt` |
| 详情加载 / 出错 | `card p-4 text-sm` + 内联 `style={{color}}` | `alert alert-info` / `alert alert-bad` |

## 这一轮补的一个类（`app-v30.css` §8.10）

| 类 | 用途 |
|---|---|
| `.th-sort`（含 `.th-sort i`） | 可排序表头按钮。整格是按钮，`border/background/padding` 必须自己归零 —— `index.css` 有意删了全局 `button{background:none}`，不归零表头会冒出一块浏览器默认灰底 |

## 修的两个 `.ln` 继承问题（影响全部已换皮页面）

1. **表头吸顶压住第一行数据**。`app-v013.css:183` 给整页列表写了
   `thead th{position:sticky;top:var(--topbar-h)}`；`.ln` 自己是 `overflow:hidden` 的滚动容器，
   吸顶表头会停在 56px 处盖住首行。在发货弹层里表现为**明细一行都看不见**（改前截图里表头下方一片空白，
   `elementFromPoint` 打到的是 `TH`）。改成 `.ln thead th{position:static}` —— 稿子的 `.ln` 本来也不吸顶。
2. **单元格对齐错了**。`app-v013.css:184` 有 `tbody td{text-align:center}`，`.ln table{text-align:left}`
   是继承，压不过直接命中 td 的规则，结果「商品名居中、金额居中、位数对不齐」。
   按稿子补 `.ln th,.ln td{text-align:left}` 与 `.ln th.num,.ln td.num{text-align:right}`
   （`design/v3.0/index.html:235` / `:248`）。

这两条在 `#462` / `#463` 的页面上同样生效，属于一起修好。

## 验收

- `tsc --noEmit` 干净；`eslint` 干净；`vitest run apps/web/src/pages/purchase` 4 文件 / 66 条全过。
- 三处测试断言跟着类名漂移同步改了：`PurchaseOrdersPage.test.tsx` 里
  `title="按X排序"` 仍由 `SortableHead` 的 `title` 提供（`th-sort` 只换样式），
  `撤销原因（必填，会记审计）` 文案原样保留（`reason-field` 只改外观）。
- 截图（同一批数据、同一 1440 视口，改前 / 改后）：
  - `purchase-detail.png` / `-before.png`：整页（详情已展开）
  - `purchase-detail-zoom.png` / `-zoom-before.png`：详情面板特写
  - `purchase-revoke.png` / `-before.png`：撤销发货块（`alert-bad` + 原因输入）
  - `purchase-form.png` / `-before.png`：开单表单整页
  - `purchase-form-zoom.png` / `-zoom-before.png`：表单特写
  - `purchase-ship.png` / `-before.png`：发货弹层
  - `purchase-ship-zoom.png` / `-zoom-before.png`：发货弹层特写

## 必须保留的 Tailwind（PR 判据的例外）

| 位置 | 类 | 为什么留 |
|---|---|---|
| 列表表 | `min-w-[920px]` | 8 列的最小宽度是**布局参数**（横向滚动阈值），不是装饰，与内贸 `min-w-[1120px]`、结算 `min-w-[1060px]` 同口径 |
| 列表表 | `w-full` / `whitespace-nowrap` / `text-right` | 列宽与对齐参数 |

## 没做的

- 详情右侧的「走到哪一步了」时间线：审计日志没有按单据过滤的参数，画出来只能是假的（与 #462 同口径）。
- 移动端竖排复测：这一轮只按 1440 视口验收，窄屏由 `.fm.lines` 的 860px 断点和 `.tw` 横向滚兜住，未逐页截图。

## 后续

加工 B / 销售 E 用同一张表往下改；冲正 R / S / I 等 #459 合入。
