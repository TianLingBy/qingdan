# 派工规范：怎么写一张能直接开工的单

> 面向：团队 6 位成员 + superagent 执行器 + 本地 CLI agent。
> 一句话：**一张好单，是「改完之后，别人用一条命令 / 一张截图就能看出它对了」的单。**

本文是 `docs/AI-WORKFLOW.md` 的执行细则——AI-WORKFLOW 讲「这活该不该派、派给谁」，本文讲「单子里必须写清什么」。

---

## 一、先认领域，再认人

派工前先看路径属于谁。归属唯一真源是 `docs/OWNERSHIP.md`，下面是速查：

| 你负责的领域 | 路径 | 不要碰 |
|---|---|---|
| 温汇敏 `2696708617-web` | 账号 / 权限域：`apps/api/src/platform/auth/**`、`apps/api/src/platform/authz*`、`apps/web/src/pages/permissions/**`、`apps/web/src/lib/access.ts` | 单据状态机、库存数量 |
| 李祖怡 `lozy66` | 八类单据与结算页：`apps/web/src/pages/{purchases,sales,internal-trades,processing,reversals,settlements,stocktakes}/**`、`packages/contracts/src/{customer-returns,supplier-returns,stocktakes,settlement-orders}.ts` 的**只读引用**（改契约要主线点头） | `apps/api/src/platform/**` |
| 梁海俊 `Vince-Leong` | 仓库 + 人员后端：`apps/api/src/modules/{masterdata,inventory,processing,internal-trade}/**` | 前端页面 |
| 何永上 `Meow-Yay` | 设计规范 + 公共组件：`apps/web/src/components/**` | 具体页面 |
| 赖皓妍 `karryL921` | 视觉稿：`design/**` | 代码 |
| 黄锦城 `TianLingBy`（主线） | 契约、platform 内核、审计、编号、部署、`docs/decisions.md` | — |

**红线路径**（只有主线能改，成员改要单独申请）：`packages/contracts/**`、`apps/api/src/platform/**`、`apps/api/migrations/**`、`docs/decisions.md`、`.github/**`。

---

## 二、开工前必须答完的四问

写单的人（不一定是你自己）要先答：

1. **改完之后，谁用什么东西能看出它对了？** —— 一条命令？一张截图？一个断言？
2. **改哪几个文件？** —— 列路径，不写「相关文件」这种话。
3. **明确不做什么？** —— 边界比范围更重要，否则执行方会顺手扩大。
4. **卡住了找谁？** —— 写 @ 谁。

四问答不出来的单，先在 issue 里讨论，**不要挂 ready 标签**。

---

## 三、单子模板（照抄）

```markdown
## 目标
一句话说清改完之后的可见变化。

## 现状与依据
- 文件:行号 —— 现在是什么样
- 文件:行号 —— 契约 / 决策怎么规定
（只写核实过的事实；不确定的写「未核实」）

## 允许改动
- 路径 1
- 路径 2

## 明确不做
- 不新增 XX 端点
- 不改 XX 状态机
- 不碰 XX 契约

## 验收
1. `pnpm -r build`
2. `pwsh -NoProfile -File tests/run.ps1`
3. 契约有改动时：`pnpm openapi` 后 `git diff --exit-code -- docs/api/openapi.yaml`
4. 前端有改动时：贴 Before / After 截图到 `docs/screenshots/`

## 卡住找谁
@xxx
```

`Blocked by` / `Blocks` 两行必须写（CI 的 `fields` 检查会挂）：

```
- Blocked by: 无
- Blocks: 无
```

---

## 四、这个产品特有的三条硬约束

### 1. 权限只有权限点，没有职位

任何 `if (role === 'owner')`、`preset_key IN ('owner','manager')` 都是错的。
写法只有一种：`allowsScope(scope, domain, action)` / `requireScope(principal, action)`。

- 一个动作只对应一件事：**能改单 ≠ 能发货**（发货是 `ship`，不是 `update`）。
- 岗位只是「默认授予一组权限点」，运行时要看权限点本身。
- 新增 domain / action 必须同改 `packages/contracts/src/domains.ts` 与 `docs/decisions.md`。

### 2. 单据动作不许编副作用

写完「完成」「确认」「审批」之前，去 repo 里看那条 `UPDATE` 到底改了什么。

- 只改单据状态，就别在注释和弹窗里写「已入库 / 已生成库存流水 / 已冲减应收」。
- 没实现的写「尚未接入（见 #xxx）」。
- 契约的 `summary` 是产品意图，不是实现事实；两者冲突时以实现为准。

### 3. 不许编 D## 决策编号

引用 `D##` 之前先查 `docs/decisions.md`，编号含义对不上就别写。查不到就写「待补」。

---

## 五、单据状态机速查（写单时对照）

| 单据 | 状态 | 关键动作端点 | 权限点 |
|---|---|---|---|
| A 采购单 | 进行中 → 已完成 / 已取消 | `POST /purchase-orders/{id}/complete` | `purchase.approve` |
| B 加工单 | 进行中 → 已完成 | `POST /processing-orders/{id}/complete` | `processing.approve` |
| E 销售单 | 进行中 → 已完成 / 已取消 | **无审批端点**（破成本下限放行 D20 尚未实现） | — |
| N 内部交易 | 进行中 → 在途 → 已完成 / 已取消 | `/dispatch`、`/dispatch-revoke`、`/receive` | `internal_trade.ship` / `.update` |
| C 结算单 | 草稿 → 已确认 | `POST /settlement-orders/{id}/confirm` | `settlement.approve` |
| R 客户退货 | 进行中 → 已完成 | `POST /customer-returns/{id}/complete` | `customer_return.create` |
| S 供应商退货 | 进行中 → 已完成 | `POST /supplier-returns/{id}/complete` | `supplier_return.create` |
| I 盘点 | 待审批 → 已审批 | `POST /stocktakes/{id}/approve` | `stocktake.approve` |
| T2 成本更正 | 待审批 → 已通过 / 已驳回 | `/approve`、`/reject` | `inventory_qty.approve` |

写单时如果发现「设计稿有这步审批、上表没有对应端点」，那说明是缺口——开单补，不要在实现里假装有。

---

## 六、派给谁

| 活的形状 | 派给 |
|---|---|
| 需求边界不清、要跟用户确认口径 | 人 + DSH 会话 |
| 要动本机 / WSL / 部署 / 密钥 / 生产数据 | DSH 会话 |
| 跨仓库、或同时改仓库外的东西 | 人 + DSH 会话 |
| 单仓库内、一条命令或一张截图能判断对错、一天内能完 | **superagent**（`@Tylanbot`） |
| 必须边跑边看（真 UI、真数据库现象） | 本地 CLI agent（Claude Code / Codex） |
| 纯文档 / 纯文本批量替换 / Office / 脚本配置 | Codex |

**并行上限 3 单**，按目录错开，不要两张单同时动同一个目录。

---

## 七、执行方的自验收清单

开 PR 之前自己跑完，红色不许提 PR：

```powershell
pnpm install --frozen-lockfile
pnpm -r build
pwsh -NoProfile -File tests/run.ps1
```

- 契约改过：`pnpm openapi` 并提交 `docs/api/openapi.yaml`
- 前端改过：贴截图到 `docs/screenshots/`
- 文件必须纯 LF、无 BOM

PR 描述里贴命令输出，没跑过的写在「备查 / 未验证」一节，不要假装跑过。

---

## 八、失败与回滚

- CI 红：同一分支继续改，不许新开分支绕。
- 主线上出问题：`git revert` 那个 squash 提交，不要 force push（分支保护已禁）。
- 卡超过 2 小时没有实质进展：在 issue 里说明卡在哪，交回派单人。
