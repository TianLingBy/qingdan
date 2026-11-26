# 加工单 B：详情、开单表单、完工验收与发货浮层换皮（#431 第四轮）

接 `README.md`（底座 + 结算 C）、`internal.md`（内贸 N）、`purchase.md`（采购 A）。
这一轮把**加工单 B** 的四处界面按同一套类换掉：详情面板、开单表单、完工 / 验收面板、发货弹层。

加工 B 是六页里表单最多的一页：开单（材料批次 + 费用 + 辅料 + 归属单）、
完工验收（损耗量 / 可售量 / 全损耗二次确认）、发货（在途分段 + 去向）。
这一轮**没有再新增底座类**：`.th-sort` 与 `.ln` 的两条修正是 #465 带进来的，这里直接用。

## 判据实测（真后端 + 真前端 + 无头 Chrome，1440×1000）

| | 改前 | 改后 |
|---|---|---|
| `ProcessingOrdersPage.tsx` 内 Tailwind 类 | **460 处** | **0** |
| `ShipDialog.tsx` 内 Tailwind 类 | **100 处** | **0** |
| 详情面板内 Tailwind 类 / 内联 style | 16 处 / 5 处 | **0 / 0** |
| 完工 / 验收面板内 Tailwind 类 | 49 处 | **0** |
| 开单表单内 Tailwind 类 | 217 处 | **0** |
| 发货弹层内 Tailwind 类 | 69 处 | **0** |
| 四块的 `clientWidth / scrollWidth` | — | 1135/1135、1135/1135、1135/1135、766/766 |

## 类映射（与前三轮同一张表）

| 位置 | 改前 | 改后 |
|---|---|---|
| 页面根容器 | `mx-auto max-w-7xl space-y-4` | `page-body` |
| 详情面板 | `card min-w-0 space-y-3 p-4` | `card detail` |
| 详情两张表（材料批次 / 费用） | `overflow-x-auto` + `table style={{minWidth:'560px'}}` + `tr.r-row` | `.ln` + `<table>` |
| 批次号单元格 | `font-mono text-xs` | `mono` |
| 商品 / 可用量 / 备注 / 时间 | `style={{color:'var(--text-3)'}}` | `cell-muted` |
| 动作区 + 禁用原因（原来两行） | `mt-4 flex flex-wrap items-center gap-3` + 另一行 `flex gap-x-4 gap-y-1` | 合成一个 `detail-acts`（原因用 `detail-why` 跟在按钮后面），取消 `act-end` |
| 撤销发货块 | `rounded-lg border border-rose-200 bg-rose-50 p-3` | `alert alert-bad` + `reason-field` + `ipt` |
| 开单表单外壳 | `space-y-4 rounded-xl … p-5 shadow-sm` | `form-card` |
| 表单标题行 | `flex flex-wrap items-center justify-between gap-2` + 取消链接 | `form-head`（取消挪到页脚 `detail-acts`） |
| 公司 / 加工厂 / 成品 / 经手人 | `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` + 逐字段 `mt-1 w-full rounded-lg border …` | `fm c4` |
| 经手人（只读） | `input readOnly` + `bg-slate-50 text-slate-600` | `<p class="fm-readonly">` |
| 新建加工厂内联表单 | `mt-2 grid gap-3 … sm:grid-cols-2` | `form-sec` + `form-sec-b fm` + 说明行 `.w` |
| 材料投入 / 费用明细分块 | `section.rounded-lg.border` + 表头条 + `overflow-x-auto` 表格 | `form-stack` + `form-head` + `.ln` + 行内 `ipt` |
| 「+ 加一行」 | `rounded border border-slate-300 bg-white px-2 py-1 text-xs` | `btn btn-row`（`费用`）/ `btn form-add`（`材料`，整行宽按钮收成内容宽） |
| 辅料 / 归属单 | `label.block` + `w-full max-w-md` | `fm` + `label.w` / `label` |
| 校验错误 / 服务端错误 | `space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700` | `alert alert-bad alert-sm` |
| 完工 / 验收面板 | `space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4` | `form-card`（绿底去掉：v3.0 的语义色只有 bad / warn / info 三档，绿色留给 `.st.ok` 状态徽标） |
| 投入量 / 可售量（只读） | `input readOnly` + `bg-slate-50` | `<p class="fm-readonly">` |
| 全损耗二次确认 | `flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3` | `alert alert-warn alert-sm`（勾选框在块内） |
| 发货弹层 | `fixed inset-0 … bg-slate-900/40 p-4` + `rounded-xl … max-w-xl` | `mask-scroll` + `sheet`（`-h` / `-b` / `-f`） |
| 弹层字段 | `label.block` + `mt-1 w-full rounded border …` | `fm`（两列）+ `.fm-readonly`（料段去向） |
| 列表单号 / 行按钮 / 动作槽 / 工具条下拉 | `font-mono text-xs underline-offset-2 hover:underline` / `btn btn-s` / `flex justify-end gap-1.5` / `rounded-lg border …` | `doc-link` / `btn btn-row` / `row-acts` / `sel` |
| 详情加载 / 出错 | `card p-4 text-sm` + 内联 `style={{color}}` | `alert alert-info` / `alert alert-bad` |

## 三个判断（都写进注释了）

1. **`alert` 只能挂块级元素**。`.alert` 靠 `padding` 撑盒子、没设 `display`，
   把全损耗那个 `<label>` 直接改成 `.alert` 会让上下内边距压到相邻元素上
   （label 默认 inline）。所以是 `div.alert` 里套 `label`。
2. **动作区与禁用原因合成一行**。改前是上下两块：一排按钮 + 另一排 `gap-x-4 gap-y-1` 的原因，
   七条原因挤成两三行、与按钮对不上。合成一个 `detail-acts` 后「哪个按钮为什么点不动」是挨着说的，
   与采购 A 同口径。
3. **完工面板去掉绿底**。原来用 `border-emerald-200 bg-emerald-50/60` 表示「这是验收」，
   v3.0 的语义色只有 bad / warn / info 三档（绿只给 `.st.ok` 状态徽标），
   所以统一成 `form-card` 安静的白底，靠标题里的「完成 / 验收」表达身份。

## 验收

- `tsc --noEmit` 干净；`eslint` 干净；`vitest run apps/web/src/pages/processing` 2 文件 / 49 条全过。
- 测试断言全是文案与 `disabled` 检查（`完成 / 验收`、`损耗量`、`可售量`、`确认全损耗并完成`、
  `扣减全部材料`、`撤销原因（必填，会记审计）`），这一轮没有一条因为类名变化而失败。
- 截图（同一批数据、同一 1440 视口，改前 / 改后）：
  - `processing-detail.png` / `-before.png`、`processing-detail-zoom.png` / `-zoom-before.png`
  - `processing-form.png` / `-before.png`、`processing-form-zoom.png` / `-zoom-before.png`
  - `processing-complete.png` / `-before.png`（完工 / 验收面板）
  - `processing-ship.png` / `-before.png`（发货弹层）

## 必须保留的 Tailwind（判据的例外，共 1 条）

| 位置 | 类 | 为什么留 |
|---|---|---|
| 列表表 | `min-w-[1040px]` | 8 列的最小宽度是布局参数（横向滚动阈值），与采购 `min-w-[920px]`、内贸 `min-w-[1120px]` 同口径 |

## 后续

销售 E 用同一张表往下改；冲正 R / S / I 等 #459 合入。
