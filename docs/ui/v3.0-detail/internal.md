# 内贸单 N：详情与开单表单换皮（#431 第二轮）

接 `README.md`（#462 的底座 + 结算单 C 样板）。这一轮把**内部交易单 N** 的详情面板与开单表单
按同一套类换掉，底座没有再新增结构性类，只补了 6 个小件（见下）。

内贸页是六页里字段结构最复杂的：两家公司、内部价、多行明细、每行多批次 chip。
它换干净了，采购 / 加工的开单表单就只剩字段多少的差别。

## 判据实测（真后端 + 真前端 + 无头 Chrome，1440×1000）

| | 改前 | 改后 |
|---|---|---|
| 详情面板内 Tailwind 类 | **44 处** | **0** |
| 开单表单内 Tailwind 类 | **124 处** | **0** |
| 内联 `style`（两处合计） | 0 | 0 |
| 详情面板 `clientWidth / scrollWidth` | 1135 / 1135 | 1135 / 1135 |
| 表单 `clientWidth / scrollWidth` | 1135 / 1135 | 1135 / 1135 |

改前表单里数出来的类（前 10）：`rounded-lg ×11`、`mt-1 ×10`、`px-3 ×9`、`text-slate-600 ×9`、
`border-slate-300 ×9`、`px-3 / py-2`、`text-[11px] ×6`、`text-slate-400 ×5`、`bg-white ×3`、
`sm:grid-cols-[1.4fr_1fr_1fr_auto_auto]`……

## 这一轮补的 6 个小件（`app-v30.css` §8.9–8.11）

| 类 | 用途 |
|---|---|
| `.form-card` | 开单表单外壳（**不能**用 `form.card`，理由见下） |
| `.form-head` / `.form-title` / `.form-stack` | 表单标题行、二级小标题、成组竖排 |
| `.fm.c3` / `.fm.lines` | 三列字段网格、明细行五列网格 |
| `.fm-readonly` | 只读字段（编辑态不让改的公司名） |
| `.line-card` / `.line-amount` / `.line-batches` | 明细行卡、行内金额、批次区 |
| `.chip` / `.chip.on` / `.chip-none` | 批次 chip 与「先选商品」提示 |
| `.reason-field` / `.act-end` / `.cell-clip` / `.cell-sub` / `.cell-none` | 撤销原因输入、靠右动作、名称截断与后缀小字 |

## 踩到的两个坑（都写进注释了）

1. **`form.card` 会命中登录页的规则**：`app-v013.css:104` 有
   `form.card .btn{width:100%;height:46px}`，那是 v0.13 给登录那张竖排表单定的。
   一旦开单表单用 `card` 类，「+ 加一行商品 / 开单 / 取消」三个按钮会全被拉成整宽黑条。
   改前截图复现得很清楚，改成 `.form-card` 后正常。
2. **明细行的 label 拿不到字段样式**：`.fm label` / `.fm input` 是挂在 `.fm` 下的后代选择器，
   把行网格单独叫 `.line-grid` 时，label 里的「标签一行、控件一行」不生效 ——
   实测「数量1」「单价」标签和输入框叠在一起。改成 `.fm.lines` 就自动继承了。

## 顺手修的一处

内贸页也把 `BatchPager` 的 `label` 传成了字面量 `"{label}"`（与结算单同一个错）。
改成「内部交易单分批翻页」。

## 验收

- `tsc --noEmit` 干净；`vitest run` 62 文件 / 619 条全过；
- 截图（同一批数据、同一视口，改前 / 改后）：
  - `internal-detail.png` / `-before.png`：整页（详情已展开）
  - `internal-detail-zoom.png` / `-zoom-before.png`：详情面板特写
  - `internal-form.png` / `-before.png`：开单表单
  - `internal-form-zoom.png` / `-zoom-before.png`：表单特写

## 后续

采购 A / 加工 B / 销售 E 等 #461 进 main（它在改同文件的表单区）；冲正 R/S/I 等 #459。
