# 库存数量页 v3.0 重做

对应 issue：#433「第三批：库存 3 页按 v3.0 实现」。

## 截图

| 文件 | 内容 |
| --- | --- |
| `inventory-before.png` | 改前（`main` 上一版库存数量页） |
| `inventory-after.png` | 改后亮色（1440×1000，真实 React 页面与静态契约数据） |
| `inventory-after-dark.png` | 改后暗色（1440×1000；全站外壳尚未迁移，暗色图只取页面面层） |
| `inventory-after-detail.png` | 行内展开批次明细与成本更正入口，亮色 |
| `inventory-after-detail-dark.png` | 行内展开批次明细与成本更正入口，暗色 |
| `inventory-proto.png` | `design/v3.0/index.html#inventory` 同尺寸稿子 |

## 与稿子的有意差异

1. **仓库列显示所属公司短 ID + 保管人姓名**
   - `InventoryBatch` 契约只有 `companyId` / `custodianId`，没有仓库 id 或仓库名。
   - 负责人已拍板采用本方案；完整 `companyId` 保留在 `title`，保管人通过现有员工姓名簿
     `useEmployeeLabel()` 展示，无权限时静默回退短 ID。
2. **快速筛选只作用于当前页返回结果**
   - `GET /inventory/batches` 没有 low / transit / hold 筛选参数。
   - 四个 chip 仍常驻并显示当前页计数；没有新增前端伪造的全量统计。
3. **点击行在表格内展开批次明细**
   - 按 #433 重做要求保留行内展开，不跳转或整页替换。
   - 明细内保留成本更正入口；`inventory_qty.update` / `approve` / `view_price` 权限边界不变。
4. **导出按钮直接使用真实端点**
   - `GET /inventory/batches/export`，权限 `inventory_qty.export`。
   - 导出固定使用当前关键字筛选，分页/排序参数按契约不发送。
5. **全站外壳未迁移**
   - 左侧栏和顶栏仍属于旧 AppLayout，不在本页一页一 PR 的范围内。

## 验收

```powershell
node tools/ui-parity/check.mjs --files apps/web/src/pages/inventory/InventoryPage.tsx
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web exec vitest run src/pages/inventory
pnpm -r build
```

当前结果：

- 机器锚点：`PASS inventory`
- Web 类型检查：0 error
- 库存目录测试：4 files / 31 tests passed
- 1440×1000 下 12 列表格 `scrollWidth === clientWidth`，无横向溢出
