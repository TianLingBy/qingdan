# 交接说明（HANDOFF）

> **用途**：新会话接手时第一个读的文档。它只写「现在在哪、下一步做什么、坑在哪」，口径细节以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准。
> **维护规则**：每次一段工作结束或换会话前更新；过期内容直接改掉，历史看 `docs/roadmap.md`。

## 0. 一分钟读完

**一句话：契约已全覆盖，实现只完成 masterdata + platform 员工 + inventory 只读。**

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；阶段 4 分工开发。 |
| 契约 | 八张单据全线登记，OpenAPI 规模 paths=50 / operations=81 / schemas=37；生成物勿手改。 |
| 实现 | masterdata 22 端点、platform 员工 4 端点、inventory 3 条只读可用；其余单据端点仍是 501 占位。 |
| 当前主线 | 补 inventory 写动作与单据侧实现，再按实现进度交付前端详情页；契约侧推进报表、打印导出。 |

## 1. 最近状态（截至 2026-11-05 下午）

| 项 | 值 |
|---|---|
| OpenAPI | `pnpm openapi` 生成 `docs/api/openapi.yaml`：paths=50 / operations=81 / schemas=37。 |
| 已登记 | A 采购 5、B 加工 5、E 销售 5 + 收款 2、N 内部交易 5、C 结算 3、R 客户退货 3、S 供应商退货 3、盘点 I 4、库存只读 3；另含 masterdata 22 与 platform 员工/岗位/公司。 |
| 已挂载 | `MOUNTED_MODULE_KEYS`：platform / masterdata / inventory / sales / purchase / processing / internal-trade / settlement。 |
| 决策 | 已到 D69：D63 客户账期、D64 加工厂报价、D65 员工岗位公司口径、D66 员工三项裁定、D67 库存四列+生成列、D68 N 单口径与状态、D69 C 单损失快照。 |
| 迁移 | 已到 `0009`：`0004` product、`0005` customer、`0006` supplier、`0007` processor+quote、`0008` inventory_batch+flow、`0009` 收紧库存批次成本/保管人非空。 |
| CI | 7 项，含 `e2e` 与 `spec-drift`；契约和路由测试均不得绕过。 |
| 盘点约束 | inventory 仅允许 `stocktake.create`、`stocktake.approve` 两个写动作，`inventory.test.ts` 使用显式白名单。 |

## 2. 已完成（不用重做）

- **masterdata**：商品、客户、供应商、加工厂四类档案与报价记录共 22 个 HTTP 端点全部可用；迁移落在 `0004`–`0007`，加工厂报价按 D64 使用独立子表。
- **platform**：员工共 4 个端点可用，含原列表及 create/update/disable；停用即失效按 D52.1 每请求重算，不缓存、不物理删。
- **inventory**：批次列表、批次详情、库存流水 3 条只读端点已接 HTTP；`0008` 建批次与流水实体，`0009` 收紧 `locked_unit_cost` / `custodian_id` 为 NOT NULL。
- **sales**：E 单 5 条及收款记录 2 条已登记；完成/出库、破下限审批等动作不在当前实现范围。
- **purchase**：A 单 5 条已登记，模块已挂载，handler 仍为 501。
- **processing**：B 单 5 条已登记，模块已挂载，handler 仍为 501。
- **internal-trade**：N 单 5 条已登记，模块已挂载，handler 仍为 501；内部价手填、独立四态、确认到货才转司见 D68。
- **settlement**：C 单 3 条已登记，模块已挂载，handler 仍为 501；相关损失取结算时快照见 D69。
- **退货与盘点契约**：R 客户退货 3 条、S 供应商退货 3 条、盘点 I 4 条均已登记；盘点审批后追加流水，不物理删历史。
- **OpenAPI 治理**：全部契约由注册表生成；`spec-drift` 在 CI 中重生成并检查 `git diff --exit-code -- docs/api/openapi.yaml`。

## 3. 团队与任务

| 人员 / 任务 | 当前状态 |
|---|---|
| 温汇敏 #45 | 继续岗位/公司实现，相关文件由她独占。 |
| 梁海俊 #49 | 已完成 inventory 只读；当前等待单据侧能力，后续接库存写/联动。 |
| 赖皓妍 | 邀请仍 pending；成员档案与前段页面任务继续挂起。 |
| 李祖怡 | 尚未开工；先完成身份核验和成员档案。 |

## 4. 下一步（按谁能领）

1. **梁海俊：inventory 写 / 单据联动**。先实现 `stocktake.create`、`stocktake.approve` 并守住显式白名单；单据侧出现可联调实现后再接库存扣减/占用/流水联动。
2. **温汇敏：岗位公司**。继续 #45 的岗位/公司 HTTP、权限和测试，不与其他人并行写同一批 platform 文件。
3. **李祖怡：单据详情页**。完成身份核验后可开工，但先有对应详情端点实现；此前只做不依赖假数据的页面骨架与字段适配，501 期间不冒充完成联调。
4. **Lead：报表与输出契约**。补齐提成、利润报表、打印导出契约，严格按“决策与契约文档 → 注册表 → `pnpm openapi` → spec-drift”顺序推进。

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
当前契约已全覆盖（paths=50 / operations=81 / schemas=37），实现仅 masterdata + platform 员工 +
inventory 只读。下一步：梁海俊接 inventory 写/联动，温汇敏续 #45 岗位/公司，李祖怡待后端实现后做
单据详情页，Lead 补提成/利润报表/打印导出契约。契约变更后必须跑 pnpm openapi。
```
