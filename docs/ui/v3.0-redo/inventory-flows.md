# 库存流水页 v3.0 重做

对应 issue：#433「第三批：库存 3 页按 v3.0 实现」中的库存流水页。

## 截图

| 文件 | 内容 |
| --- | --- |
| `inventory-flows-before.png` | 改前（上一版库存流水页） |
| `inventory-flows-after.png` | 改后亮色（1440×1000，真实 React 页面与真实接口结构数据） |
| `inventory-flows-after-dark.png` | 改后暗色（1440×1000；全站外壳尚未迁移，暗色图只取页面面层） |
| `inventory-flows-proto.png` | `design/v3.0/index.html#inventory-flows` 同尺寸稿子 |

## 逐块对照

| 区块 | 稿子 | 实现 |
| --- | --- | --- |
| 页面标题 / 说明 | 库存流水；解释可用量为什么变，只追加不修改 | 一致，并写明本页只展示冻结契约真实提供的字段 |
| 页头按钮 | 导出 | **不画**。冻结契约没有库存流水导出端点，`inventory_flow` 只有 `GET /inventory/flows` |
| 搜索 | 批次、来源单据、经手人 | 一致；使用当前批返回结果做前端检索 |
| 快速筛选 | 全部 / 入库 / 出库 / 锁定 / 调整 | 按 D2=A 改为全部 / 正变动 / 负变动 / 零变动，不伪造锁定、调整类型 |
| 只追加提示 | 稿子有 | 一致 |
| 精确筛选 | 稿子没有 | 保留真实后端的公司 / 来源类型 / 来源单号 / 批次追溯，并常驻显示当前筛选 |
| 表头 | 时间 / 批次 / 类型 / 变动量 / 金额 / 来源单据 / 经手人 | 冻结契约无金额、类型字段，改为发生时间 / 批次 ID / 方向 / 变动量 / 来源类型 / 来源单据 / 经手人 |
| 四态 | filled / empty / loading / error | 一致，四分支常驻 DOM，由 `data-state` 切换 |
| 分页 | 页码条 | 流水只有 `cursor/limit`，使用上一批 / 下一批，并显示当前返回条数 |
| 权限 | `inventory_flow.read` | 保持后端权限真源；无导出按钮，不借用 `inventory_qty.export` |

## 与稿子的有意差异

1. **不显示金额、锁定、调整**
   - `InventoryFlowSchema` 只有 `delta` / `sourceDocType` / `sourceDocId` 等冻结字段，没有
     `type` / `amount` / `unitCost`。
   - 负责人已在 #433 拍板 D2=A：只按 `delta` 正负与 `sourceDocType` 如实展示。
2. **不显示导出**
   - 设计稿有导出按钮，但 `docs/api/feature-matrix.md` 的库存流水域只有
     `GET /inventory/flows`，没有导出端点。
3. **批次列显示批次 ID**
   - 契约没有批次号 join；用户主动追溯批次号后，命中行显示批次号，其余行显示短 ID，
     完整 ID 保留在 `title`。
4. **方向 chip 只筛当前批**
   - 后端没有方向筛选参数；当前批内筛选用 chip，来源类型 / 来源单号 / 批次使用真实查询参数。

## 已知机器验收差异

`node tools/ui-parity/check.mjs --files apps/web/src/pages/inventory/InventoryFlowsPage.tsx`
仍会要求「金额」「锁定」「调整」。这三项与 #433 正文和冻结契约直接冲突，本页按 D2=A
未画，未修改 `tools/ui-parity/**` 或 `anchors.json`。

## 验收

```powershell
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web exec vitest run src/pages/inventory
pnpm -r build
```
