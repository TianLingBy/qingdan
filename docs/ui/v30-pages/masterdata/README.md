# 主数据四页 · v3.0 对照截图（#432）

一页四 tab：`/products` `/customers` `/suppliers` `/processors` → 同一个组件
`apps/web/src/pages/masterdata/MasterdataPage.tsx`（`ProductsPage` / `CustomersPage` /
`SuppliersPage` / `ProcessorsPage` 四个导出）。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `before-*.png` | 改前（`origin/main` 旧实现，1440 宽） |
| `<page>.png` | 改后（本 PR 实现，1440 宽，亮色） |
| `draft-*.png` | 稿子（`design/v3.0/index.html#<page>`，1440 宽） |
| `detail-customers.png` | 客户详情面板：基本信息 / 联系方式 / 对接人 / 最近单据 |
| `detail-processors.png` | 加工厂详情面板：基本信息 / 联系方式 / 对接人 / 最近单据 / 报价记录 |

> `before-*.png` 是把 `origin/main` 的组件做静态渲染拍的：旧实现全用 Tailwind 工具类，
> 静态渲染环境没加载 Tailwind，所以只有结构（4~5 列 + 行内三按钮）可参考，颜色/间距不能当基线。

## 表头逐列对照

| 页 | 稿子 = `tools/ui-parity/anchors.json` | 本 PR |
| --- | --- | --- |
| 商品资料 | 编号 / 名称 / 规格 / 参考价 | 同 |
| 客户档案 | 编号 / 名称 / 对接人 / 价目 / 历史销售 | 同（价目 / 历史销售 见下方缺口） |
| 供应商档案 | 编号 / 名称 / 对接人 / 历史采购 | 同（历史采购 见下方缺口） |
| 加工厂档案 | 编号 / 名称 / 对接人 / 加工单 / 报价 | 同（加工单 / 报价 见下方缺口） |

`node tools/ui-parity/check.mjs 商品|客户|供应商|加工厂` 四页全 PASS。

## 有意差异（4 条，都在 #432 说过）

1. **多了「新建 X」按钮**：稿子四个档案页右上为空，但 #432 必做点 1 明确要求「新建按钮」——
   按 issue 执行，并在详情面板里放编辑 / 删除。
2. **多了公司下拉**：只有 `me.companyIds.length > 1` 才出现，是 repo 既有的多公司隔离入口
   （`*ListQuerySchema` 都有 `companyId`），不是新造筛选项。
3. **列表单元格居中**：`app-v013.css:184` 的 `tbody td{text-align:center}`，
   `app-v30.css` 只把 `thead th` 改成左对齐，`tbody td` 没覆盖 → 表头左、内容居中对不齐。
   `docs/ui/frontend-change-rules.md` §三.2 明令「页面 PR 里不要再改样式表」，所以本 PR 不动
   `apps/web/src/styles/**`，已在 #432 报给负责人（一行补丁即可，全批次受益）。
   数字列按稿子 `td.r num` 右对齐，不受影响。
4. **页脚是「本页 N 条 + 第 N 批」**，不是稿子的「共 N 条 + 页码 + 10/20/50 条每页」：
   主数据列表走 `PageQuerySchema`（游标分页），**后端不返回 `total`**，编不出总数与页码
   （`TODO(#341)`）。已同 #432 报给负责人。

## 后端缺口（不造接口，占位 `—` + title）

| 列 | 稿子口径 | 后端现状 |
| --- | --- | --- |
| 客户「价目」 | 协议价 / 标准价 | `CustomerSchema` 无价目字段，契约还写明「客户不带任何金额口径」 |
| 客户「历史销售」 | 该客户销售单数（`1 笔`） | 只有 `GET /customers/{id}/summary` 的 `orderCount`，列表接口不返回；一页 20 行 = 20 次请求 |
| 供应商「历史采购」 | 采购单数 | 同上，`GET /suppliers/{id}/summary` |
| 加工厂「加工单」 | 加工单数 | 同上，`GET /processors/{id}/summary` |
| 加工厂「报价」 | 报价条数（`2 条`） | 只有 `GET /processor-quotes?processorId=`，列表接口不返回 |

这些值在**打开行后的详情面板里是真实数据**（单次请求 `summary` / `processor-quotes`），
列表列上只放 `—`，`title` 写明缺哪个端点 + 「口径待负责人定（#432）」。

## 复现

```bash
# 机器验收（三道关第 1 关）
node tools/ui-parity/check.mjs 商品
node tools/ui-parity/check.mjs 客户
node tools/ui-parity/check.mjs 供应商
node tools/ui-parity/check.mjs 加工厂

# 类型 / 测试 / 构建
pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web exec vitest run src/pages/masterdata src/pages/employees
pnpm -r build

# 稿子对照图
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless --disable-gpu \
  --hide-scrollbars --window-size=1440,760 --virtual-time-budget=9000 \
  --run-all-compositor-stages-before-draw \
  --screenshot=draft-customers.png \
  "file:///<repo>/design/v3.0/index.html#customers"
```
