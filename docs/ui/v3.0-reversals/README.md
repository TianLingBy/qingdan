# 冲正页（R / S / I）v3.0 收口截图

`#431` 第一批最后一页。截图由 `.tmp/e2e-v013/shoot-reversals-v30.mjs` 产出，
条件是真后端（PGlite + `apps/api/src/app.ts` 的 `buildApp`）+ 真前端（vite dev）+
无头 Chrome（1440×1000，`taskbar` 无关），数据由 `seed-reversals.mjs` /
`seed-stocktakes.mjs` 真调接口造出来（R 2 张、S 2 张、I 2 张）。

| 文件 | 内容 |
| --- | --- |
| `before-r-list.png` / `after-r-list.png` | R 客户退货分栏整页（改前 / 改后） |
| `before-r-footer.png` / `after-r-footer.png` | 列表卡页脚特写（改前 / 改后） |
| `after-s-list.png` / `after-s-footer.png` | S 供应商退货分栏 |
| `after-i-list.png` / `after-i-footer.png` | I 盘点盈亏分栏 |

## 改了什么

| | 改前（v0.13 版式） | 改后（v3.0） |
| --- | --- | --- |
| 列表卡 | `section.card.min-w-0`，卡内自带标题行「客户退货单 / 共 2 条」 | `div.card.list-card`，标题交给页头与分栏名，不再重复 |
| 表格滚动 | `div.overflow-x-auto` | `div.tw`（与采购 A / 销售 E 等五页同一条滚动轨道） |
| 页脚 | `.pager` 直接挂在卡里，左「共 2 条 · 第 1 批」+ 右文字按钮「上一批 / 下一批」 | `.tf`：左「共 N 条」+ 右 `<BatchPager>`（`‹ 第 1 批 ›`，图标按钮） |
| 筛选条 | 三个带字段名（公司 / 状态 / 单号关键字）的 `label`，高一行 | `.toolbar`：控件一条线，字段名走 `aria-label`；关键字输入框用 `.search` |
| 主按钮 | `bg-slate-900` 手写 | `btn btn-primary` |
| 表单块 | `rounded-xl border bg-white` 手写 | `card` |
| 「操作」列 | 空表头 | `操作`（右对齐，与五页单据列表一致） |

## 实测（`shoot-reversals-v30.mjs` 里的 `measure()` 输出）

```
[after-r] {"listCard":true,"tw":1135,"twScroll":1135,"table":1135,"pagerShown":"flex","rows":2}
[after-s] {"listCard":true,"tw":1135,"twScroll":1135,"table":1135,"pagerShown":"flex","rows":2}
[after-i] {"listCard":true,"tw":1135,"twScroll":1135,"table":1135,"pagerShown":"flex","rows":2}
```

- `tw.scrollWidth === table.scrollWidth === 1135`：1440 视口下三栏都没有横向滚动；
- 改前 `listCard:false`、`pagerShown:null`（没有 `.tf`，`.pager` 是卡片里的一条）；
- 页脚在 `filled` 态才显示分页：`.list-card:not([data-state="filled"]) .tf .pager{display:none}`
  这条规则由 `app-v30.css` 给，空 / 加载 / 出错态自动收起。

## 为什么不给暗色图

与 `docs/ui/v3.0-purchase/README.md`、`docs/ui/v3.0-docs/README.md` 同一条原因：
**这一版还没有主题开关**。`apps/web/src/main.tsx` 写死 `data-mode="light"`，外壳
（侧边栏 / 顶栏）也是 Tailwind 浅色写死；只把页面 token 切暗，截出来是「白底浅字」。
暗色验收要等「主题开关」那一单把 `main.tsx` + 外壳一起换成吃 token，届时补亮暗双模图。

## 没画的东西（后端没有）

- **合计**：三栏都是游标分页（`PageQuerySchema`，只回 `nextCursor`），没有 total，
  按本批行数求和标「合计」是假数据 —— 页脚只写「共 N 条」。
- **页码**：同上，`BatchPager` 只写「第 M 批」，不画假页码（`1 2 3 … 9`）。
- **导出 CSV**：`customer_return` / `supplier_return` / `stocktake` 三域都没有 export 端点。
- **「+ 新建冲正」页头按钮**：稿子里有，但三类单的入参与权限点完全不同，
  建单入口留在各自分栏里（说明见 `ReversalsPage.tsx` 行内注释）。
