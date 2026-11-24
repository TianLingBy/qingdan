# 四态与组件对照（新 UI v3.0 · 给 repo 的对接稿）

- 目的：这份设计稿要上传到 `TianLingBy/qingdan`，本文件把「设计稿怎么落到 `apps/web`」讲清楚，**只写能直接抄的东西**，不重复业务口径。
- 对照基准：`docs/ui/frontend-change-rules.md`（#431 指定验收口径）+ `apps/web/src/lib/list-state.ts` + `apps/web/src/styles/app-v013.css:38-53` + `apps/web/src/styles/README.md` §四态。
- 设计稿本体：`design/v3.0/index.html`（单文件；下文行号按 2026-11-24 版本）。

## 一、四态：设计稿已经是 CSS 驱动，可以照抄

设计稿里**没有一处 JS 条件渲染**：四个分支常驻 DOM，切换只写属性（`applyState()`，index.html:1153-1160）。

### 1. 列表页 —— `data-state` 挂 `<tbody>`

```tsx
<div className="card list-card" data-state={state}>
  <tbody data-state={state}>
    {rows.map(r => <tr key={r.id} className="r-row">…</tr>)}
    <tr className="st-tr st-empty"><td colSpan={cols}><空态：标题/说明/主按钮 /></td></tr>
    <tr className="st-tr st-loading"><td colSpan={cols}><骨架 sk 条 /></td></tr>
    <tr className="st-tr st-error"><td colSpan={cols}><失败说明 + 重试按钮 /></td></tr>
  </tbody>
</div>
```

CSS 全部来自 `app-v013.css`，**不用新写**：

```css
tbody[data-state="empty"] > tr.r-row, tbody[data-state="loading"] > tr.r-row, tbody[data-state="error"] > tr.r-row { display: none }
tbody > tr.st-tr { display: none }
tbody[data-state="empty"] > tr.st-tr.st-empty, tbody[data-state="loading"] > tr.st-tr.st-loading, tbody[data-state="error"] > tr.st-tr.st-error { display: table-row }
tbody > tr.st-tr > td { padding: 0; border-bottom: none; white-space: normal; height: auto }
```

好处：**表头不消失、列宽不塌**；这也是 `list-state.ts:6-11` 里点名「不许用 `rows.length === 0 ? <EmptyRow/> : rows.map(...)`」的原因。

> 尺度提醒：设计稿的 `.st-ico` 是 **54px**（在表格行里，别把整页空态那种大插图塞进去），仓库 `app-v013.css:61` 是 **96px**（整页空态用）。类名相同、尺寸按位置二选一，**不要两套并存**，否则后加载的规则会覆盖。
> 设计稿在契约之外只加了一条：`.list-card:not([data-state="filled"]) .tf .pager{display:none}`（空/加载/错误时收起分页），repo 可照搬也可不搬。

### 2. 面板页 —— `data-state` 挂容器 + `.st-block`

```tsx
<section className="panel" data-state={state}>
  <div className="st-block st-filled">…真实内容…</div>
  <div className="st-block st-empty">…空态…</div>
  <div className="st-block st-loading">…骨架…</div>
  <div className="st-block st-error">…错误 + 重试…</div>
</section>
```

### 3. 状态从哪来

```ts
import { resolveListState } from '@/lib/list-state';
const state = resolveListState({ isPending, hasError, isEmpty });   // loading → error → empty → filled
```

设计稿的演示开关 `S.view` 就等价于这个 `state`（`filled / empty / loading / error`，**不是 `ok`**：#431 正文的 `ok` 是笔误，仓库三处代码都写 `filled`）。

### 4. 每页属于哪一层（22 页）

| 层 | 页面 |
|---|---|
| **列表 · `<tbody>` 四态** | 采购 A / 加工 B / 销售 E / 内部交易 N / 结算 C / 冲正（页内三栏各自的列表）/ 商品 / 客户 / 供应商 / 加工厂 / 库存数量 / 库存流水 / 盘点 / 员工 / 操作日志 / API 与集成 / 公司管理 |
| **面板 · `.st-block` 四态** | 工作台 / 业务全流程图 / 权限设置（矩阵本体，周边 KPI 另算）/ 利润报表（金额表与 KPI 一起进 `st-filled`）/ 设置中心 / 登录页（`data-state` 驱动 idle/loading/error，见下）/ 入企页（joined/invalid） |

## 二、登录与入企的 `data-state`

设计稿：`<form class="lg-form" id="lgForm" data-state="idle|loading|error">`，三个分支常驻（`.lg-alert` 只在 error 显示），提交时**只改属性**并把提交按钮置 `disabled` + 转圈。

- 登录错误态：`data-state="error"` → 表单顶部告警条 + 输入框转红（`index.html` 里 `.lg-form[data-state="error"]` 那组规则）。
- 入企三态：码无效 `invalid` / 已加入 `joined` / 成功回登录。
- 与 #435 要求的差异：**布局是「6:4 左品牌右表单」而不是居中卡片** —— 按负责人「设计以本稿为主」保留，repo 若要居中卡片需明说。

## 三、权限按钮

- 判权只用 `allows(scope, domain, action)`，**不写职位判断**。
- 无权限：`disabled` + `title="需要 <domain>.<action> 权限"`；状态不允许：`disabled` + 写明原因；可点：`title="执行「X」· 需要 <domain>.<action> 权限"`。
- 设计稿目前出现的 cap（按来源分两组）：

| 来源 | cap |
|---|---|
| #425 明确给的真名（可直接用） | `processor.create` · `stocktake.create` / `stocktake.delete` / `stocktake.approve` · `inventory.export` · `purchase_order.export` · `permission.update` |
| 沿用早期 docket 写法（**需要与契约统一后再定稿**） | `purchase.ship` / `purchase.update` · `processing.ship` / `processing.approve` · `sales.ship` / `sales.approve` · `internal.ship` / `internal.approve` · `settlement.approve` · `reversal.create` · `employee.update` · `apikey.create` / `apikey.update` |

> 差异点：#425 写「采购发货/撤销售/到货确认 = `purchase_order.ship`」，而设计稿的采购单用的是 `purchase.ship` + `purchase.update`。**建议 repo 落地时以 `packages/contracts/src/domains.ts` 为准**，设计稿这边只需同步文案。

## 四、分页

- 位置：列表卡片页脚右侧（`.tf` 里），左边保留「共 N 条 · 合计」。
- 控件：首页 / 上一页 / 页码（>7 页折叠省略号）/ 下一页 / 末页 + `10 / 20 / 50 条每页`。
- 行为：合计按**全部筛选结果**算（不是当前页）；改搜索/筛选/页大小回第 1 页；`empty / loading / error` 时分页隐藏（设计稿用 `.list-card:not([data-state="filled"]) .tf .pager{display:none}`）。
- 请求参数名以后端 list 路由为准，设计稿不发明参数。

## 五、新加的 24 枚图标（可直接进图标组件）

规范同现有：`viewBox="0 0 24 24"`、`fill:none`、`stroke:currentColor`、`stroke-width:1.6`、`round` 端点、默认 18px。

| 名字 | path | 用途 |
|---|---|---|
| `pg-first` | `M17 6l-6 6 6 6M8 6v12` | 分页首页 |
| `pg-prev` | `M15 6l-6 6 6 6` | 上一页 |
| `pg-next` | `M9 6l6 6-6 6` | 下一页 |
| `pg-last` | `M7 6l6 6-6 6M16 6v12` | 末页 |
| `clock` | `M12 8v4l3 2M12 21a9 9 0 100-18 9 9 0 000 18z` | 库龄 |
| `trend` | `M4 17l6-6 4 4 6-7M20 8h-4M20 8v4` | 趋势 |
| `trash` | `M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6` | 删除 / 吊销 |
| `pencil` | `M4 20h4L19 9l-4-4L4 16zM14 6l4 4` | 编辑 |
| `key` | `M9 15a3 3 0 100-6 3 3 0 000 6zM11.1 12.9L20 4M17 7l3 3M15 9l2 2` | 密钥 |
| `shield` | `M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4` | 只追加 / 受保护 |
| `refresh` | `M20 11a8 8 0 10-2.3 7M20 5v6h-6` | 重试 / 重发 / 加载 |
| `calendar` | `M4 6h16v14H4zM4 10h16M8 3v4M16 3v4` | 统计周期 |
| `filter` | `M3 5h18l-7 8v6l-4 2v-8z` | 筛选无结果 |
| `arrow-in` | `M12 4v13m0 0l-5-5m5 5l5-5` | 入库 |
| `arrow-out` | `M12 20V7m0 0l-5 5m5-5l5 5` | 出库 |
| `adjust` | `M4 8h9m4 0h3M4 16h3m4 0h9M15 5v6M9 13v6` | 调整 |
| `ticket` | `M4 8h16v3a2 2 0 000 4v3H4v-3a2 2 0 000-4z` | 邀请码 / 入企 |
| `check` | `M5 13l4 4L19 7` | 允许 / 批准 |
| `undo` | `M9 14l-4-4 4-4M5 10h9a5 5 0 010 10h-4` | 驳回 |
| `copy` | `M9 9h11v11H9zM15 5H4v11` | 复制密钥 |
| `star` | `M12 4l2.4 5 5.6.8-4 4 .9 5.6-4.9-2.7-4.9 2.7.9-5.6-4-4 5.6-.8z` | 主对接人 |
| `pin` | `M12 3v9m0 0l4 3v-3H8v3zM9 15h6M12 15v6` | 锁定 |
| `split` | `M4 5v14M20 5v14M8 9l4 3-4 3M16 12H8` | 拆分 / 调拨 |

## 六、与 #425「不许画」的一致性

| #425 禁止 | 设计稿现状 |
|---|---|
| 销售单 approve 环节 | 保留「签收完成（`sales.approve`）」，依据 #419/#331 与负责人 11-22 拍板 |
| 物理删除单据 | 没有；单据只有取消 / 冲正。盘点删除只在「待审批」态，属 `stocktake.delete` 真端点 |
| 批量操作 | 没有。所有动作一次一条 |
| 附件上传 | 没有 |
| 打印 PDF | 只有浏览器打印 HTML 客户联（与「`/print` 回 HTML 文本」一致） |
| 别的统计图表 | 只有 `profit_report`（毛利）与工作台既有指标；权限矩阵不是统计 |

## 七、验收命令（照 #431/#432 的写法）

```powershell
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web exec vitest run src/pages
pnpm -r build
```

设计稿侧的验证不等同于 repo 验证：本稿的自动化在 `迭代\patches\newui-features-test.mjs`（77 项）、`newui-lines-state-test.mjs`（26 项）、`newui-interaction-test.mjs`（19 项）、`newui-sweep.mjs`（22 页 × 亮暗 × 四态），证据在 `迭代\_newui\*.json`。

## 八、已知差异（repo 侧要拍的两处）

1. **主数据**：repo 是「`/products` `/customers` `/suppliers` `/processors` 同一页四 tab」，设计稿是四个导航页。按负责人「设计以本稿为主」**未改形**；若 repo 侧坚持 tab，需把设计稿的长尾改动（tab 条 + 切页动效）补进来。
2. **工作台**：repo 要求「入口卡片按 `/auth/me` 的 entries 渲染 + 未实现页置灰」，设计稿是数据仪表盘形态。同样按「设计以本稿为主」保留；入口的**数据来源**照 repo 走（本稿的侧栏导航是设计稿演示，不构成实现口径）。
