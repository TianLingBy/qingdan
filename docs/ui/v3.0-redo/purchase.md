# 采购单 A · v3.0 重做记录（#431 第一批样板）

- 页面：`/purchase-orders` → `apps/web/src/pages/purchase/PurchaseOrdersPage.tsx`
- 稿子：`design/v3.0/index.html#purchase-orders`（`PG['purchase-orders']` 由 L1635–1640 的 `DOC` 驱动）
- 截图（1440×1000 同宽）：`docs/ui/v3.0-redo/purchase-{before,after,proto}.png`，另附 `purchase-after-detail.png`
- 机器验收：`node tools/ui-parity/check.mjs 采购单` → PASS

## 第 2 关：逐块自查（稿子 → 实现）

| 块 | 稿子 | 实现 | 结论 |
| --- | --- | --- | --- |
| 标题 | `采购单 A` | `采购单 A` | 一致 |
| 说明 | `向供应商采购，货到入库建批次并锁定批次价（D5）。` | 同文 | 一致（原先是自写的三行长文） |
| 右上按钮 | `＋ 新建采购单`（`btn pri`） | `+ 新建采购单`（`btn btn-p`） | 文案/主次一致；无 create 权限时 `disabled` + `title="需要 purchase.create 权限"` |
| 工具栏顺序 | 搜索框 → 状态统计片 →（撑开）→ 全部单据/只看我的 → 全部经手人 | 搜索框 → 状态统计片 →（撑开）→ 全部单据/只看我的 | 顺序一致；经手人下拉缺（见「有意差异」2） |
| 状态统计片 | `全部 9 / 进行中 3 / 在途 3 / 已完成 3`（只列数据里出现过的状态） | 同结构，条数只在「一页装得下全部」时画 | 结构一致（见「有意差异」3） |
| 表头 | 单号 / 供应商 / 物料 / 数量 / 金额 / 状态 / 负责人 / 日期 | 同 8 列同顺序 | 一致（原先是 货款 / 开单时间 + 一个操作列） |
| 排序 | `th.so` 伪元素 ↕ / ↑ / ↓，白名单 单号 / 金额 / 日期 | 同 | 一致（排序仍发服务端，`sort=orderNo|totalAmount|createdAt`） |
| 行内交互 | 整行可点进详情，无行内按钮 | `tr.r-row.click` + `tabIndex` + Enter，无行内按钮 | 一致（「编辑 / 发货 / 完成 / 取消」都在详情面板里） |
| 页脚 | `共 N 条 · 合计 ¥…` + 分页 | 同 | 一致（原先是「共 N 张」；合计只在一页装得下全部时给） |
| 四态 | `data-state` 挂容器与 `tbody`，三行 `st-tr st-*` 常驻 | 同 | 一致 |
| 权限态 | 无权限 `disabled` + `title="需要 <domain>.<action> 权限"` | 新建按钮按 `purchase.create`；看价缺失时金额走 `—` | 一致 |

## 量化对比（`getComputedStyle`，1440×1000）

| 指标 | 稿子 | 实现 |
| --- | --- | --- |
| 标题字号 | 26px | 26px |
| 说明字号 | 13.5px | 13.5px |
| 表头字号 / 行高 | 12px / 42px | 12px / 42px |
| 数据行行高 | 50px | 50px |
| 表格字号 | 13.5px | 13.5px |
| 统计片高度 | 32px | 32px |
| 横向溢出 | 0 | 0 |

## 有意差异（请在 PR 里裁定，不是漏做）

1. **`导出 CSV` 没画**：后端 `GET /purchase-orders/export` 存在（`purchase.export`），但属 #425「本期不接」的 11 个端点之一；画一个接不上的按钮比不画更糟。要接的话单独一张单（前端 `ApiClient` 目前没有二进制/文本下载通道，需要加一条）。
2. **`全部经手人` 下拉没画**：`PurchaseOrderListQuerySchema` 只有 `companyId / supplierId / status / keyword / scope`，没有 `handlerId`，下拉接了也筛不动。
3. **统计片的条数可能是空的**：后端列表只回 `total`、不回分组计数，所以只在「一页装得下全部」（`rows.length >= total`）时画数字，翻页态不画——否则本页 7 张会被读成全量 7 张。
4. **外壳（左侧栏 / 顶栏）没动**：属全站布局，不在一页一 PR 的范围；顶栏那条「你好，XX / 浏览器基线 / 设置 / 退出登录」要收，得单独一张单并重刷 22 页截图。
5. **按钮圆角用 999px（胶囊）**：#443 的口径是「颜色 / 圆角冲突以 `tokens-v013` 为准」，稿子的 10px 圆角没有搬；这条要改也是全站一次性改 `app-v013.css` 的 `.btn` 圆角，不能只改本页。
6. **状态徽标比稿子略大**：repo 的 `.st` 是 v0.13 口径（24px→本仓 26px），稿子 24px；同样属全站组件。

## 本轮新增的样式底座（`app-v30.css` §9）

稿子的列表页外壳类在 repo 里一直缺（#443 当时为不动另外 21 页没搬），各页只能拿 `p-head` + `toolbar` + Tailwind 拼，这是前五轮「骨架像、细节跑偏」的共同原因。本轮补齐并只在采购单页启用：

`.ph` `.acts` `.grow` `.tools` `.chips` `.field` `.list-card` 内表格密度 `th.so` `tr.click` `td.r`

均用已桥接的 `--v30-*` 与 `tokens-v013` 的 `--mono` / `--fs-*`，未新造令牌；`.card` / `.btn` / `.chip` / `.pager` 本体仍复用 `app-v013.css`。另外三页（B / E / N / C）会直接复用这一节，不再各拼一套。
