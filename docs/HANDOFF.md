# 交接说明（HANDOFF）

> **用途**：新会话接手时第一个读的文档。它只写「现在在哪、下一步做什么、坑在哪」，口径细节以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准。
> **维护规则**：每次一段工作结束或换会话前更新；过期内容直接改掉，历史看 `docs/roadmap.md`。

## 0. 一分钟读完

**一句话：契约全覆盖、86 个 operation 全部可用；提成（D77）与看价脱敏（D78）已落地，剩模块间库存联动（#99，归梁海俊）、利润报表（#97，卡 processing 损失金额）、在线支付（#101，卡真实商户号）与前端 22 页（归赖皓妍/李祖怡）。**

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；阶段 4 分工开发。 |
| 契约 | 八张单据全线登记，OpenAPI 规模 paths=55 / operations=86 / schemas=38（D71 盘点拆盘盈/盘亏、D72 E 单完成、D77 提成配置）；生成物勿手改。 |
| 实现 | masterdata 22、platform 员工 4、sales 11（E 6 含 D72 完成 + 收款 2 + R 3）、purchase 8（A 5 + S 3）、processing 5、internal-trade 5、settlement 6（C 3 + 提成配置 3）、inventory 3 只读 + 盘点 I 5 全部可用；**86 个 operation 已无 501**。 |
| 当前主线 | ①**#79 已通 E 单**（D70 端口 + D72 完成）：E 单完成 = 扣库存 + 生成 C 草稿；**N 单完成（转司 + 在途量）仍待拍板**（2026-11-07 的 D73–D76 实现已按越界回滚）；②**提成已落地（D77，#96）**：按人配置 + 确认结算时解析并快照，`commissionOwnerId` 由来源单带入；③**看价脱敏已落地（D78，#110）**：无 `settlement.view_price` 时 C 单金额返回 null，有权限的详情读取记 `amount.detail`；④前端登录页重做——**先落 #3 成员档案**；⑤剩利润报表、打印导出、在线支付契约未登记。 |
| 前端 | `apps/web` 已回到 22 页骨架态：#82/#83 的 M1-G 登录页接线与黑白毛玻璃视觉已由 **#90 撤回**（2026-11-07 合并）。 |

## 1. 最近状态（截至 2026-11-07 晚）

| 项 | 值 |
|---|---|
| main | `0b02c6c`（#112 D78 看价脱敏）+ `606b4d6`（#109 D77 提成）+ `4f1742d`（#108 越界教训）。 |
| OpenAPI | `pnpm openapi` 生成 `docs/api/openapi.yaml`：paths=55 / operations=86 / schemas=38。 |
| 已登记 | A 采购 5、B 加工 5、E 销售 6（含完成）+ 收款 2、N 内部交易 5、C 结算 3、提成配置 3、R 客户退货 3、S 供应商退货 3、盘点 I 5（盘盈/盘亏各一条 create）、库存只读 3；另含 masterdata 22 与 platform 员工/岗位/公司。 |
| 已挂载 | `MOUNTED_MODULE_KEYS`：platform / masterdata / inventory / sales / purchase / processing / internal-trade / settlement。 |
| 决策 | 已到 D78：D77 提成比例配置（按人 + 确认结算时解析并快照）、**D78 看价脱敏 + 敏感金额读取审计（7 个金额字段 null、详情记 `amount.detail`）**。下一号 D79（D73–D76 随 2026-11-07 越界改动回滚作废，编号不复用）。 |
| 迁移 | 已到 `0018`：`0016` settlement_orders、`0017` inventory_stocktakes、**`0018` settlement_commission（提成比例表 + `settlement_order.commission_owner_id`）**（更早见 §2）。 |
| 11-06/07 合并 | #82/#83 前端 M1-G（**已被 #90 撤回**）、#86、#88、#89、#91、#92 盘点权限 D71、#94 E 单完成 D72、**#107 越界改动回滚（-1859 行，D73–D76 作废）**、**#108 模块边界教训**、**#109 提成 D77**、**#112 看价脱敏 D78**。 |
| CI | 7 项，含 `route` / `fields`（PR 描述必带 `Blocked by:` 与 `Blocks:`）、`e2e` 与 `spec-drift`；契约和路由测试均不得绕过。 |
| 盘点约束 | inventory 写动作 = `stocktake.increase.create`（scope `stocktake.create`）、`stocktake.decrease.create`（scope `stocktake.delete`）、`stocktake.approve`；`inventory.test.ts` 用显式白名单，新增盘点写端点必须同步白名单。 |

## 2. 已完成（不用重做）

- **masterdata**：商品、客户、供应商、加工厂四类档案与报价记录共 22 个 HTTP 端点全部可用；迁移落在 `0004`–`0007`，加工厂报价按 D64 使用独立子表。
- **platform**：员工共 4 个端点可用，含原列表及 create/update/disable；停用即失效按 D52.1 每请求重算，不缓存、不物理删。
- **inventory**：批次列表、批次详情、库存流水 3 条只读 + 盘点 I 4 条（list/create/detail/approve）已接 HTTP；`0008` 建批次与流水，`0009` 收紧成本/保管人非空，`0017` 建盘点单表。审批同事务改 `inbound_qty` 并追加 `source_doc_type='stocktake'` 流水；唯一改批次的函数是 `apps/api/src/modules/inventory/services/stock-flow.ts`（D67）。#89 已把批次 `custodian_id` 快照写进审批审计（`changes->>'custodianId'`，F5）。**单据→库存流水联动仍未做，待 #79 拍板**；**盘点权限口径（D47）待 #84/D71**。
- **sales**：E 单 5 + 收款记录 2 + R 客户退货 3 全部可用（`0013`/`0014`）。E 单行金额与单头合计由 SQL 计算，D20 下限按「同行批次等额引用」算加权平均成本（`sales_order_line.cost_floor`），破线直接 422 + 失败审计，**没有审批流**。R 的「减成交额退款」需要按 C 单快照重算，settlement 当时无表，留 TODO。
- **purchase**：A 单 5 + S 供应商退货 3 全部可用（`0010`/`0011`）。
- **processing**：B 单 5 全部可用（`0012`）；可售量 = 投入 − 损耗由 SQL 计算。
- **internal-trade**：N 单 5 全部可用（`0015`）；内部价手填、独立四态见 D68；**转司确认（接收方到货）未实现**。
- **settlement**：C 单 3 全部可用（`0016`）；confirm 需 `settlement.approve`、AI 禁审批且必须带 reason，成功时冻结 `related_loss_amount_snapshot`（D69）；**D77 起确认时按 `commission_owner_id` 解析本公司最新比例并快照**（无配置/负毛利记 0），提成配置 3 端点见 `commission-rates.ts`；**D78 起金额按 `settlement.view_price` 脱敏**（list/detail/confirm 响应，有权限的详情读取记 `amount.detail`）；E 单完成态自动生成 C 草稿已通（D72），N 单侧待拍板。 |
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

1. **N 单完成 + 损失归集（#79 剩余部分，归梁海俊）**：E 单已通（D72）。剩下的：N 内部交易单完成的在途量释放与批次转司（D22/D31）、D35 的 B 单损失归集（要 processing 侧端口）、单据→库存流水联动（#99）。注意 D73–D76 的实现已于 #107 整体回滚，**编号不复用，重做时要新开 D 编号**。
2. **梁海俊：#99 单据→库存流水联动**（A/B/R/S 四条链路，含批次增删与成本锁价）；issue 已回到未领取状态。
3. **赖皓妍：先落 #3 成员档案 PR**，合并后再接 #4 登录页（接口已全部就绪，可真联调）。
4. **Lead：报表与输出契约**。提成已登记并实现（D77）、看价脱敏已落地（D78）；利润报表（#97，卡 processing 的损失金额未落地）、打印导出（#98，归李祖怡）、在线支付（#101，需真实商户号）按「决策 → 契约 → 注册表 → `pnpm openapi` → spec-drift」推进；sales/purchase 同款脱敏按 D79 追加。

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

- **D70 / D71 已拍板并落地**（#93 端口通道、#92 盘点权限 D71），#84 已关；不要再按「等拍板」处理。
- **GitHub Actions 账单停摆**（仅负责人可处理）：7 项检查 0 步骤、2–3 秒内 FAILURE，注解 `The job was not started because recent account payments have failed…`；恢复前一切 PR 的 CI 都是红的，与代码无关（此状态下的合并需负责人明确同意）。
- 赖皓妍已能推 PR（#82/#83/#90 都是她的），但**成员档案 #3 仍未落盘**；#4 及其后续 UI 任务在她交档案前保持挂起。
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
当前契约已全覆盖（paths=55 / operations=86 / schemas=38），**86 个 operation 全部可用、无 501**
（A/B/E/收款/R/S/N/C + 提成配置 + masterdata + platform 员工 + inventory 只读 + 盘点 I）。
main 已合到 #112（2026-11-07，D78 看价脱敏），提成 D77 与脱敏 D78 均已落地；前端已由 #90 撤回回到 22 页骨架。
下一步：①梁海俊接 #99 单据→库存流水联动、#79 剩余 N 单完成；②赖皓妍先交 #3 成员档案再开 UI；
③Lead 补利润报表（#97，卡 processing 损失金额）/打印导出（#98，归李祖怡）/在线支付（#101，需商户号）。
契约变更后必须跑 pnpm openapi。
```
