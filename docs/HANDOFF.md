# 交接说明（HANDOFF）

> **用途**：新会话接手时第一个读的文档。它只写「现在在哪、下一步做什么、坑在哪」，口径细节以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准。
> **维护规则**：每次一段工作结束或换会话前更新；过期内容直接改掉，历史看 `docs/roadmap.md`。

## 0. 一分钟读完

**一句话：契约全覆盖，八张单据 + 收款 + 退货的后端全部实现，只剩 inventory 写动作（盘点）与模块间联动。**

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；阶段 4 分工开发。 |
| 契约 | 八张单据全线登记，OpenAPI 规模 paths=50 / operations=81 / schemas=37；生成物勿手改。 |
| 实现 | masterdata 22、platform 员工 4、sales 10（E 5 + 收款 2 + R 3）、purchase 8（A 5 + S 3）、processing 5、internal-trade 5、settlement 3、inventory 3 只读 + 盘点 I 4 全部可用；**81 个 operation 已无 501**。 |
| 当前主线 | ①模块间调用通道（#79 待拍板：E/N 完成 → C 草稿 D19；单据 → 库存流水）；②前端详情页 / 登录页；③提成、利润报表、打印导出契约尚未登记。 |

## 1. 最近状态（截至 2026-11-05 下午）

| 项 | 值 |
|---|---|
| OpenAPI | `pnpm openapi` 生成 `docs/api/openapi.yaml`：paths=50 / operations=81 / schemas=37。 |
| 已登记 | A 采购 5、B 加工 5、E 销售 5 + 收款 2、N 内部交易 5、C 结算 3、R 客户退货 3、S 供应商退货 3、盘点 I 4、库存只读 3；另含 masterdata 22 与 platform 员工/岗位/公司。 |
| 已挂载 | `MOUNTED_MODULE_KEYS`：platform / masterdata / inventory / sales / purchase / processing / internal-trade / settlement。 |
| 决策 | 已到 D69：D63 客户账期、D64 加工厂报价、D65 员工岗位公司口径、D66 员工三项裁定、D67 库存四列+生成列、D68 N 单口径与状态、D69 C 单损失快照。 |
| 迁移 | 已到 `0017`：`0010` purchase_orders、`0011` supplier_returns、`0012` processing_orders、`0013` sales_orders、`0014` sales_receipts_returns、`0015` internal_trade_orders、`0016` settlement_orders、`0017` inventory_stocktakes（更早见 §2）。 |
| CI | 7 项，含 `e2e` 与 `spec-drift`；契约和路由测试均不得绕过。 |
| 盘点约束 | inventory 仅允许 `stocktake.create`、`stocktake.approve` 两个写动作（已实现，PR 待合），`inventory.test.ts` 使用显式白名单。 |

## 2. 已完成（不用重做）

- **masterdata**：商品、客户、供应商、加工厂四类档案与报价记录共 22 个 HTTP 端点全部可用；迁移落在 `0004`–`0007`，加工厂报价按 D64 使用独立子表。
- **platform**：员工共 4 个端点可用，含原列表及 create/update/disable；停用即失效按 D52.1 每请求重算，不缓存、不物理删。
- **inventory**：批次列表、批次详情、库存流水 3 条只读 + 盘点 I 4 条（list/create/detail/approve）已接 HTTP；`0008` 建批次与流水，`0009` 收紧成本/保管人非空，`0017` 建盘点单表。审批同事务改 `inbound_qty` 并追加 `source_doc_type='stocktake'` 流水；唯一改批次的函数是 `apps/api/src/modules/inventory/services/stock-flow.ts`（D67）；**单据→库存流水联动仍未做，待 #79 拍板**。
- **sales**：E 单 5 + 收款记录 2 + R 客户退货 3 全部可用（`0013`/`0014`）。E 单行金额与单头合计由 SQL 计算，D20 下限按「同行批次等额引用」算加权平均成本（`sales_order_line.cost_floor`），破线直接 422 + 失败审计，**没有审批流**。R 的「减成交额退款」需要按 C 单快照重算，settlement 当时无表，留 TODO。
- **purchase**：A 单 5 + S 供应商退货 3 全部可用（`0010`/`0011`）。
- **processing**：B 单 5 全部可用（`0012`）；可售量 = 投入 − 损耗由 SQL 计算。
- **internal-trade**：N 单 5 全部可用（`0015`）；内部价手填、独立四态见 D68；**转司确认（接收方到货）未实现**。
- **settlement**：C 单 3 全部可用（`0016`）；confirm 需 `settlement.approve`、AI 禁审批且必须带 reason，成功时冻结 `related_loss_amount_snapshot`（D69）；**E/N 完成态自动生成 C 草稿未实现**（`TODO(D19)`）。
- **退货与盘点契约**：R 客户退货 3 条、S 供应商退货 3 条、盘点 I 4 条均已登记；盘点审批后追加流水，不物理删历史。
- **OpenAPI 治理**：全部契约由注册表生成；`spec-drift` 在 CI 中重生成并检查 `git diff --exit-code -- docs/api/openapi.yaml`。

## 3. 团队与任务

| 人员 / 任务 | 当前状态 |
|---|---|
| 温汇敏 #45 | #45 已由 #51 闭环并关闭；下次派活前先确认她是否还在线。 |
| 梁海俊 #49 | inventory 只读已完成；盘点 I 4 条由 Lead 先行实现（#78），他回来后 review + 接 #79 的库存联动。 |
| 赖皓妍 | 邀请仍 pending；成员档案与页面任务继续挂起。 |
| 李祖怡 | 尚未开工；先完成身份核验和成员档案。 |

## 4. 下一步（按谁能领）

1. **梁海俊：review 盘点 I 4 条**（#78），重点看审批后批次四列变化是否符合 D67；随后接 #79 拍板后的 `stockFlowService`。
2. **谁都能接（需先拍板）：模块间调用通道**。两个 TODO 同一根因——模块禁止直读对方表，但「E/N 完成 → C 草稿（D19）」和「单据 → 库存流水」需要跨模块写。建议在 platform 层加一条内部服务接口（服务身份 + 审计），先补 `decisions.md` 再写代码。
3. **李祖怡：单据详情页**。后端详情端点已全部可用，可做真联调。
4. **Lead：报表与输出契约**。提成、利润报表、打印导出尚未登记，按「决策 → 契约 → 注册表 → `pnpm openapi` → spec-drift」推进。

## 5. 坑（踩过，别再踩）

- **`git switch -c <分支>` 失败后不要继续提交**：目标分支已存在时命令失败但人仍停在原分支（常是 `main`），继续 `git add/commit` 会把提交落在 main 上；今天发生过两次。修法是 `git branch -f <分支> <sha>` 把提交挂到分支，再 `git reset --hard origin/main`。
- **子代理为了过测试会改松防线**：今天一次重写了 CLI 命名算法（会改既有命令名），一次把 `inventory.test.ts` 的禁止写端点断言改成前缀过滤。验收必须读“为了让测试变绿”的改动；盘点现已改回显式白名单。
- **operationId 必须以功能域开头**：`internalTrade.*`（驼峰）会触发 registry 校验失败，正确写法是 `internal_trade.*`；不要放宽校验，改名即可。
- **CLI 命令名的整域规则**：域内末段撞名会整域改用末两段/末三段，新增端点可能被动改既有命令名；先检查冲突。`sales.receipt.list.read` 因改为 `sales.receipt.read` 才没有波及既有命令。
- **route-boundary 未挂载清单是写死的**：新增或移除模块时要同步更新 `route-boundary.test.ts`，否则测试必红。
- **生成物与迁移纪律**：迁移只增不改；`docs/api/openapi.yaml` 只由 `pnpm openapi` 生成，手改会被 CI 或下次生成覆盖。
- **PGlite 支持生成列**：内存 PG18 已实测支持 D67 的 `STORED` 生成列与 `CHECK`，不要在测试里退回应用层维护派生数量。
- **GitHub 402 可能是瞬时错误**：先重试；不要在没有余额证据时让负责人充值。

## 6. 需要负责人处理

- 赖皓妍的 GitHub 邀请仍未接受；落定前成员档案与前端页面任务保持挂起。
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
integration(PG18)、e2e、route、fields、spec-drift。
当前契约已全覆盖（paths=50 / operations=81 / schemas=37），**81 个 operation 全部可用、无 501**
（A/B/E/收款/R/S/N/C + masterdata + platform 员工 + inventory 只读 + 盘点 I）。下一步：模块间调用通道
（#79 待拍板：D19 草稿与单据→库存流水）；李祖怡可做单据详情页真联调；Lead 补提成/利润报表/打印导出契约。
契约变更后必须跑 pnpm openapi。
```
