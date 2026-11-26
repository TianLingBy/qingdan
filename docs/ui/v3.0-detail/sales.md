# 销售单 E：详情、收款块、扫码收款面板与开单表单换皮（#431 第五轮）

接 `README.md`（底座 + 结算 C）、`internal.md`（内贸 N）、`purchase.md`（采购 A）、`processing.md`（加工 B）。
这一轮把**销售单 E** 的四处界面按同一套类换掉：详情面板、内嵌的「收款记录」块、
扫码收款面板（`PaymentRequestPanel.tsx`）、开单表单。

E 单与前面几页的差别：详情里嵌着一整套「收款」界面 —— 台账表 + 追加收款表单 + 二维码面板，
三层套在一起，所以这一轮真正新增的只有二维码那四件（`.qr-*` / `.text-bad`）和一条 `.vtop`。

## 判据实测（真后端 + 真前端 + 无头 Chrome，1440×1000）

| | 改前 | 改后 |
|---|---|---|
| `SalesOrdersPage.tsx` 内 Tailwind 类 | **596 处** | **0** |
| `PaymentRequestPanel.tsx` 内 Tailwind 类 | **92 处** | **0** |
| 详情面板内 Tailwind 类 / 内联 style | 68 处 / 5 处 | **0 / 0** |
| 收款记录块内 Tailwind 类 | 36 处 | **0** |
| 扫码收款面板内 Tailwind 类 | 31 处 | **0** |
| 开单表单内 Tailwind 类 | 181 处 | **0** |
| 五块的 `clientWidth / scrollWidth` | — | 1150/1150、1110/1110、1108/1108、1150/1150 |

（详情、收款块、开单表单都在 1440 视口下的 1150px 卡片宽里，二维码面板嵌在收款块内是 1108px。）

## 类映射（与前四轮同一张表）

| 位置 | 改前 | 改后 |
|---|---|---|
| 页面根容器 | `mx-auto max-w-7xl space-y-4` | `page-body` |
| 详情面板 | `card min-w-0 space-y-3 p-4` | `card detail` |
| 详情两张表（商品 / 费用） | `overflow-x-auto` + 表格 + `style={{minWidth}}` | `.ln` + `<table>` |
| 明细里的批次号 | `inline-flex gap-1 rounded border … px-2 font-mono text-xs` | `chip-row` + `chip chip-static` + `mono` |
| 商品 / 备注 / 时间 | `style={{color:'var(--text-3)'}}` 等 | `cell-muted` |
| 动作区与 7 条禁用原因 | 按钮一行 + `flex gap-x-4 gap-y-1` 一行 | 合成一个 `detail-acts`（原因 `detail-why` 跟在按钮后），取消 `btn danger act-end` |
| 撤销块 | `rounded-lg border border-rose-200 bg-rose-50 p-3` | `alert alert-bad` + `reason-field` + `ipt` |
| 收款记录块外壳 | `rounded-lg border border-slate-200` | `form-sec`（`form-sec-h` 标题条 + `form-sec-b form-stack` 正文） |
| 收款台账表 | 原生表 + `px-4 py-3` 逐格 | `.ln`；方向徽标 `st ok` / `st warn` |
| 追加收款表单 | `flex flex-wrap items-center gap-2` + 逐字段 `mt-1 w-full rounded border …` | `form-sec` > `form.form-sec-b form-stack` + `fm c4` + `detail-acts` |
| 扫码收款面板 | `rounded-lg border border-slate-200 bg-slate-50 p-4` | `form-sec` + `form-sec-h` + `form-sec-b` |
| 二维码外框 / 占位 | `rounded-lg border border-slate-300 bg-white p-3` + `flex h-[168px] w-[168px] …` | `qr-box` / `qr-empty`（白底是硬编码的，见判断 2） |
| 二维码右侧信息列 | `min-w-[240px] space-y-1 text-sm` | `qr-meta`；小字后缀 `cell-sub`；过期倒计时 `text-bad` |
| 模拟支付提示 | `rounded border border-amber-300 bg-amber-50 p-2` | `alert alert-warn alert-sm` |
| 开单表单外壳 | `space-y-4 rounded-xl … p-5 shadow-sm` | `form-card` |
| 表单标题行 | `flex flex-wrap items-center justify-between gap-2` + 取消链接 | `form-head`（取消挪到页脚 `detail-acts`） |
| 公司 / 客户 / 经手人 / 合计 | `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` + 逐字段 `mt-1 w-full rounded-lg border …` | `fm c4`；经手人与合计 `<p class="fm-readonly">`（合计加 `mono`） |
| 商品明细行 | `align-top` + 逐格 `ipt` + 批次 chip | `tr.vtop` + `ipt` + `chip` / `chip-x` / `chip-none` |
| 费用明细 | 原生表 + `px-3 py-2` | `.ln` + `ipt` + `row-acts` |
| 「+ 加一行」 | `rounded border … px-2 py-1 text-xs` | `btn form-add`（整宽收成内容宽） |
| 合计条 | `flex gap-4 border-t pt-3 text-sm` | `sum-bar` |
| 校验 / 服务端错误 | `space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700` | `alert alert-bad alert-sm` |
| 列表单号 / 行按钮 / 动作槽 / 工具条下拉 | `font-mono text-xs underline-offset-2 hover:underline` / `btn btn-s` / `flex justify-end gap-1.5` / `rounded-lg border …` | `doc-link` / `btn btn-row` / `row-acts` / `sel` |
| 排序表头 | `inline-flex items-center gap-1 font-medium hover:text-slate-900` + `text-xs text-slate-400` | `th-sort` + `<i>` |
| 工具条尾注 | `ml-auto text-sm` + 内联 `style={{color}}` | `toolbar-end` |
| 详情加载 / 出错 | `card p-4 text-sm` + 内联 `style={{color}}` | `alert alert-info` / `alert alert-bad` |

## 四个判断（都写进注释了）

1. **「收款记录」块必须留框。** 中途试过只套 `form-stack`（纯纵向 flex，无边框），
   结果块与上下两张表糊成一片、看不出这里是一组独立的收款台账。改成 `form-sec` 后，
   标题条回到改前的样子（`form-sec-h` 的浅底 + 下边框），而内部仍用 v3.0 的表与表单。
   标题条里「收款记录 + 块内余额」用一层 `form-head` 挤成一组 —— 它本身 `space-between`，
   但这一组是 auto 宽、没有多余空间，等于左对齐 + gap 8，不必为此新增类。
2. **二维码外框是全仓唯一一处写死的白底。** `--v30-*` 里没有「永远是白」这一档，
   而二维码扫的是深模块与白底的对比度，跟着主题走就扫不出来。所以 `.qr-box{background:#fff}`
   是有意硬编码的，并在注释里写明理由；占位文字的 `#666` 同理（它只出现在这块白底上）。
3. **`.btn.btn-p` 白底不是这一轮改坏的，但确实看不出来是主行动作。**
   `app-v013.css:98` 把 `.btn-p` 与 `.btn-primary` 一起定义成深底，可同一份文件 322 行的
   `.btn{background:var(--surf-1)}` 特异性相同、位置更靠后，把它压回白底 ——
   于是全仓 14 处 `btn btn-p`（发货 / 签收 / 确认）在视觉上与普通描边按钮没有区别。
   这一轮**不动全局配色**（超出「只换皮」范围、且会影响已合入的五页），只在 PR 里标出来待拍板；
   要修就是一条 `.btn.btn-p{…}` 提特异性，可单独成一个提交。
4. **明细表行的靠顶对齐另起 `.vtop`。** 改前 `tr.align-top` 是 Tailwind 工具类；
   一行里「引用批次」那格可能是两行 chip、别的格是单行控件，默认 `middle` 会把下拉框
   拉到行中间、与标签错开半个控件高。改为 `.ln tr.vtop td{vertical-align:top}`。

## 验收

- `tsc --noEmit` 干净；`eslint src/pages/sales` 干净；`vitest run apps/web/src/pages/sales` 4 文件 / 59 条全过。
- 有**一条**测试断言因类名变化而失败并已更新：`详情落在 card 上…` 里
  `class="card min-w-0 space-y-3 p-4"` → `class="card detail"`（同一处语义，换的是外壳类名）。
- 截图（同一批数据、同一 1440 视口，改前 / 改后）：
  - `sales-detail.png` / `-before.png`、`sales-detail-zoom.png` / `-zoom-before.png`
  - `sales-receipt.png` / `-before.png`（空态）、`sales-receipt-rows.png` / `-before.png`（收款 + 退款两行）
  - `sales-qr.png` / `-before.png`（扫码收款面板）
  - `sales-form.png` / `-before.png`、`sales-form-zoom.png` / `-zoom-before.png`

## 必须保留的 Tailwind（判据的例外，共 1 条）

| 位置 | 类 | 为什么留 |
|---|---|---|
| 列表表 | `min-w-[1120px]` | 9 列的最小宽度是布局参数（横向滚动阈值），与内贸 `min-w-[1120px]`、结算 `min-w-[1060px]`、采购 `min-w-[920px]`、加工 `min-w-[1040px]` 同口径 |

另：`className="whitespace-nowrap"` 仍出现在列表单元格上（`doc-link` 所在列与状态列），
它不在判据列出的模式里，且与内贸 / 采购两页的写法一致，留作列内换行控制。

## 后续

冲正 R / S / I 的详情与表单等 #459 合入；`.btn-p` 是否提特异性待拍板。
