# 交接说明（HANDOFF）

> **用途**：新会话接手时第一个读的文档。它只写「现在在哪、下一步做什么、坑在哪」，口径细节以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准。
> **维护规则**：每次一段工作结束或换会话前更新；过期内容直接改掉，历史看 `docs/roadmap.md`。

## 0. 一分钟读完

**一句话：后端 85 个接口全部可用（无 501）；E 单完成、N 单主链（开单→发货→到货确认/转司→C 草稿）已闭环；剩四条单据→流水联动、提成/报表/打印/成本更正/支付，以及整块前端 22 页与打包部署。CI 因 GitHub 账单停摆。**

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；阶段 4 分工开发。 |
| 契约 | 八张单据全线登记，OpenAPI 规模 **paths=55 / operations=85 / schemas=37**（D71 盘点拆盘盈/盘亏、D72 E 单完成、D73 N 单发货）；生成物勿手改。 |
| 实现 | masterdata 22、platform 21、sales 11（E 6 含 D72 完成 + 收款 2 + R 3）、purchase 8（A 5 + S 3）、processing 5、**internal-trade 7（含 D73 发货、D74 到货确认/转司）**、settlement 3、inventory 8（只读 3 + 盘点 5）全部可用；**85 个 operation 已无 501**。 |
| 当前主线 | ①**#79**：E 单完成（D72）、N 单发货（D73）、**N 到货确认/转司（D74/D75）全部落地，N 侧闭环**；②欠账已全部建成 issue：#96 提成、#97 利润报表、#98 打印导出、#99 四条流水联动、#100 成本更正、#101 在线支付、#102 前端 22 页、#103 真实 PG e2e；③前端仍是 22 页占位；④#3 赖皓妍成员档案仍是「待本人确认」。 |
| 前端 | `apps/web` 已回到 22 页骨架态：#82/#83 的 M1-G 登录页接线与黑白毛玻璃视觉已由 **#90 撤回**（2026-11-07 合并）。 |

## 1. 最近状态（截至 2026-11-07 晚）

| 项 | 值 |
|---|---|
| main | `6eb819e`（#105 D74 N 到货确认/转司）；前一版 `e2911dd`（#104 D74 口径）、`de082c2`（#95 D73 发货）、`e4990bf`（#94 D72 E 单完成）。 |
| OpenAPI | `pnpm openapi` 生成 `docs/api/openapi.yaml`：**paths=55 / operations=85 / schemas=37**。 |
| 已登记 | A 采购 5、B 加工 5、E 销售 6（含完成）+ 收款 2、**N 内部交易 7（含发货 + 到货确认/转司）**、C 结算 3、R 客户退货 3、S 供应商退货 3、盘点 I 5、库存只读 3；另含 masterdata 22 与 platform 21（员工/岗位/公司/审计/Token/权限）。 |
| 已挂载 | `MOUNTED_MODULE_KEYS`：platform / masterdata / inventory / sales / purchase / processing / internal-trade / settlement。 |
| 决策 | 已到 D75：D63 客户账期、D64 加工厂报价、D65 员工岗位公司口径、D66 员工三项裁定、D67 库存四列+生成列、D68 N 单口径与状态、D69 C 单损失快照、**D70 模块间通道（platform 内部服务端口）**、**D71 盘点权限（盘盈 create / 盘亏 delete + 角色矩阵）**、**D72 E 单完成**、**D73 N 单发货（在途占用 + 取消释放）**、**D74 N 到货确认/转司**、**D75 N→C 草稿取数修正**。下一号 D76。 |
| 迁移 | 已到 `0017`：`0010` purchase_orders、`0011` supplier_returns、`0012` processing_orders、`0013` sales_orders、`0014` sales_receipts_returns、`0015` internal_trade_orders、`0016` settlement_orders、`0017` inventory_stocktakes（更早见 §2）。 |
| 11-07 合并 | #92 盘点权限 D71、#93 模块间通道 D70、**#94 E 单完成 D72**、**#95 N 单发货 D73**；#84 已按证据关闭；#82/#83 前端 M1-G 由 #90 撤回。 |
| CI | 7 项（`test` ubuntu/windows、`integration` PG18、`e2e`、`route`、`fields`、`spec-drift`）。**2026-11-07 起全部 0 步骤秒红：GitHub Actions 账单停摆**（注解 `recent account payments have failed or your spending limit needs to be increased`）；#94/#95 在本机全量门禁通过后由负责人授权合并，账单恢复后需重跑 CI 补形式记录。 |
| 盘点约束 | inventory 写动作 = `stocktake.increase.create`（scope `stocktake.create`）、`stocktake.decrease.create`（scope `stocktake.delete`）、`stocktake.approve`；`inventory.test.ts` 用显式白名单，新增盘点写端点必须同步白名单。 |

## 2. 已完成（不用重做）

- **masterdata**：商品、客户、供应商、加工厂四类档案与报价记录共 22 个 HTTP 端点全部可用；迁移落在 `0004`–`0007`，加工厂报价按 D64 使用独立子表。
- **platform**：员工共 4 个端点可用，含原列表及 create/update/disable；停用即失效按 D52.1 每请求重算，不缓存、不物理删。
- **inventory**：批次列表、批次详情、库存流水 3 条只读 + 盘点 I 4 条（list/create/detail/approve）已接 HTTP；`0008` 建批次与流水，`0009` 收紧成本/保管人非空，`0017` 建盘点单表。审批同事务改 `inbound_qty` 并追加 `source_doc_type='stocktake'` 流水；唯一改批次的函数是 `apps/api/src/modules/inventory/services/stock-flow.ts`（D67）。#89 已把批次 `custodian_id` 快照写进审批审计（`changes->>'custodianId'`，F5）。**单据→库存流水联动仍未做，待 #79 拍板**；**盘点权限口径（D47）待 #84/D71**。
- **sales**：E 单 5 + 收款记录 2 + R 客户退货 3 全部可用（`0013`/`0014`）。E 单行金额与单头合计由 SQL 计算，D20 下限按「同行批次等额引用」算加权平均成本（`sales_order_line.cost_floor`），破线直接 422 + 失败审计，**没有审批流**。R 的「减成交额退款」需要按 C 单快照重算，settlement 当时无表，留 TODO。
- **purchase**：A 单 5 + S 供应商退货 3 全部可用（`0010`/`0011`）。
- **processing**：B 单 5 全部可用（`0012`）；可售量 = 投入 − 损耗由 SQL 计算。
- **internal-trade**：N 单 5 全部可用（`0015`）；内部价手填、独立四态见 D68；**转司确认（接收方到货）未实现**。
- **settlement**：C 单 3 全部可用（`0016`）；confirm 需 `settlement.approve`、AI 禁审批且必须带 reason，成功时冻结 `related_loss_amount_snapshot`（D69）；**E/N 完成态自动生成 C 草稿未实现**（`TODO(D19)`）。
- **退货与盘点契约**：R 客户退货 3 条、S 供应商退货 3 条、盘点 I 4 条均已登记；盘点审批后追加流水，不物理删历史。
- **OpenAPI 治理**：全部契约由注册表生成；`spec-drift` 在 CI 中重生成并检查 `git diff --exit-code -- docs/api/openapi.yaml`。
- **前端（apps/web）**：仅 22 页骨架 + 路由骨架，**没有**登录页真接线、会话态、路由守卫。M1-G 那版（#82/#83）已被 #90 整份撤回，重做时按 #4 验收标准来。

## 3. 团队与任务

| 人员 / 任务 | 当前状态 |
|---|---|
| 温汇敏 #45 | #45 已由 #51 闭环并关闭；下次派活前先确认她是否还在线。 |
| 梁海俊 #49 | 已 review 盘点 I（开 #84）；#89 已补保管人快照进审计。下一步等他接 #79 拍板后的 `stockFlowService` 与 #84 权限分支。 |
| 赖皓妍 | 已在仓里活动（#82/#83 登录页 → #90 自行撤回）。**成员档案 #3 仍未落盘**，按规则 UI 任务保持挂起，先让她交档案 PR。 |
| 李祖怡 | 尚未开工；先完成身份核验和成员档案。 |

## 4. 下一步（按谁能领）

1. ~~N 到货确认 / 转司~~ ✅ **已闭环（D74 / D75 / #105）**：`internal_trade.order.receive` 落地，同一事务内解锁占用 + 转司 + 生成 C 草稿；只有接收方可确认。
2. **四条单据→库存流水联动（#99）**：A 采购入库、B 加工产出、R 退货入库、S 退货出库，照 E 单完成（D72）的写法走 D70 端口。
3. **前端 22 页（#102 + #4/#5/#6）**：现在全是 `PlaceholderPage`；赖皓妍的 #3 成员档案仍未确认，UI 任务仍挂起。
4. **欠账清单已全部建档**：#96 提成、#97 利润报表、#98 打印导出、#99 流水联动、#100 成本更正、#101 在线支付、#102 前端 22 页、#103 真实 PG e2e。按 p0 → p1 顺序领。

## 5. 坑（踩过，别再踩）

- **`git switch -c <分支>` 失败后不要继续提交**：目标分支已存在时命令失败但人仍停在原分支（常是 `main`），继续 `git add/commit` 会把提交落在 main 上；今天发生过两次。修法是 `git branch -f <分支> <sha>` 把提交挂到分支，再 `git reset --hard origin/main`。
- **子代理为了过测试会改松防线**：今天一次重写了 CLI 命名算法（会改既有命令名），一次把 `inventory.test.ts` 的禁止写端点断言改成前缀过滤。验收必须读“为了让测试变绿”的改动；盘点现已改回显式白名单。
- **operationId 必须以功能域开头**：`internalTrade.*`（驼峰）会触发 registry 校验失败，正确写法是 `internal_trade.*`；不要放宽校验，改名即可。
- **CLI 命令名的整域规则**：域内末段撞名会整域改用末两段/末三段，新增端点可能被动改既有命令名；先检查冲突。`sales.receipt.list.read` 因改为 `sales.receipt.read` 才没有波及既有命令。
- **route-boundary 未挂载清单是写死的**：新增或移除模块时要同步更新 `route-boundary.test.ts`，否则测试必红。
- **生成物与迁移纪律**：迁移只增不改；`docs/api/openapi.yaml` 只由 `pnpm openapi` 生成，手改会被 CI 或下次生成覆盖。
- **PGlite 支持生成列**：内存 PG18 已实测支持 D67 的 `STORED` 生成列与 `CHECK`，不要在测试里退回应用层维护派生数量。
- **GitHub 402 可能是瞬时错误**：先重试；不要在没有余额证据时让负责人充值。
- **PR 描述缺阻塞字段会被 `fields` 4 秒打红**：报错原文 `缺少阻塞字段：Blocked by:、Blocks:`。`gh pr create` 生成的正文常缺这两行，补 `- Blocked by: 无` / `- Blocks: 无` 后 `gh pr edit <n> --body-file` 触发 `edited` 事件即重跑。
- **撤回别人的 PR 前必须先 rebase 到当前 main**：#90 基于旧 main，直接合会把 #86/#88/#89 三个修复一起撤掉（GitHub 只报 `CONFLICTING`，不说会删别人的提交）。做法：`git checkout -B tmp/revert origin/feat/x` → `git rebase origin/main` → 看 `git diff --stat` 只剩撤回范围 → 跑全量测试 → `git push --force-with-lease origin tmp/revert:feat/x`。
- **别信「CI 没触发就是过了」**：webhook 偶发不投递，用 `gh pr checks <n>` 确认 7 项都出现在列表里；缺项就 `gh workflow run test.yml --ref <分支>` 或补一个空提交重跑。

## 6. 需要负责人处理

- **恢复 GitHub Actions 账单（唯一硬阻塞）**：Settings → Billing & plans；注解原文 `recent account payments have failed or your spending limit needs to be increased`。恢复后把 #94/#95 的 CI 重跑（或对 main 重跑）补齐形式记录。
- **赖皓妍确认 #3 成员档案**：`docs/members/赖皓妍.md` 里的正文是主线 2026-11-04 替她起草的，状态仍是「⬜ 待本人确认」；她的 GitHub 账号 `karryL921` 已由她本人 3 个已合并 PR（#82/#83/#90）验证，只剩她逐项确认后开一个档案 PR。**在那之前 #4/#5/#6/#102 的 UI 任务按规则挂起。**
- 李祖怡先完成中文姓名、GitHub 账号、负责模块三处核验；未通过不得领任务或写代码。
- `dsh-agent-conductor` 补丁需在 DSH 重启后验证 240 秒空闲窗口与自动续跑，插件升级后还要重打。

## 7. 交接前自检命令

```powershell
cd D:\Desktop\dsh\Qingdan
git status --short                           # 本任务应只有 docs/HANDOFF.md
pwsh -NoProfile -File scripts/sync-check.ps1 # 依赖、口径、等待关系
pwsh -NoProfile -File tests\run.ps1          # 退出码 0 才算通过
pnpm -r test
pnpm openapi
git diff --exit-code -- docs/api/openapi.yaml
gh pr checks <PR 编号或 URL>                 # 7 项：test(ubuntu)、test(windows)、
                                             # integration(PG18)、e2e、route、fields、spec-drift
```

## 8. 给新会话的开场话

```text
接手「轻单」工程仓（D:\Desktop\dsh\Qingdan）。先读 docs/START-HERE.md 与 docs/HANDOFF.md，再按
docs/AGENT-TEAM.md 开工：DSH 拆任务/派活/验收/提交，代码交 Claude Code，杂项交 Codex。
先核验中文姓名、GitHub 账号、负责模块；未核验不得领任务或写代码。开工先跑
pwsh -NoProfile -File scripts/sync-check.ps1；PR 须过 7 项 CI：test(ubuntu)、test(windows)、
integration(PG18)、e2e、route、fields、spec-drift，且 PR 正文必须带 Blocked by: / Blocks: 两行。
当前 paths=55 / operations=85 / schemas=37，**85 个 operation 全部可用、无 501**（A/B/E/收款/R/S/N/C +
masterdata + platform + inventory 只读 + 盘点 I + N 发货）。main 在 de082c2，前端仍是 22 页占位（#90 曾
撤回 M1-G）。口径已到 D74（N 到货确认/转司已定、实现待做）。下一步：①按 D74 实现到货确认/转司；
②四条单据→库存流水联动（#99）；③前端 22 页（#102，#3 档案未确认前挂起）；④#103 真实 PG e2e。
**CI 现状：GitHub Actions 因账单停摆，7 项全 0 步骤秒红**，恢复账单后才能按 CI 绿合并。
契约变更后必须跑 pnpm openapi。
```
