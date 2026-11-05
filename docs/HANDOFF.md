# 交接说明（HANDOFF）

> **用途**：新会话接手时**第一个读的文档**。它只写「现在在哪、下一步做什么、坑在哪」，口径细节仍以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准（本文不复制口径，避免两处漂移）。
> **维护规则**：每次一段工作结束、或换会话前更新一次；过期内容直接改掉，不堆历史（历史看 `docs/roadmap.md` 变更记录）。

## 0. 一分钟读完

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；当前是阶段 4 分工开发。 |
| masterdata | 商品、客户、供应商、加工厂四类档案 + 报价记录共 **22 条端点全部可用**；迁移覆盖 `0004`–`0007`。 |
| inventory | 3 条只读契约 + 3 个实体；模块已挂载，handler 仍为 501，梁海俊按 #49 实现中。 |
| sales | 5 条契约 + 4 个实体；模块已挂载，handler 仍为 501；完成/出库、收款记录、破下限审批本批未做。 |
| platform | 员工 create/update/disable 3 条已实现；岗位 4 条、公司 3 条仍在实现。 |
| 团队 | 温汇敏 #51 已合并；梁海俊 #49 已解封；赖皓妍邀请仍 pending，#3/#4/#5/#6 挂起；李祖怡尚未开工。 |
| 开工入口 | 先读 `docs/START-HERE.md`，核验身份后按个人档案接活；每次开工前跑 `scripts/sync-check.ps1`。 |
| 当前总阻塞 | 前端线等赖皓妍接受邀请；未完成身份核验者不得领任务、写代码。 |

## 1. 最近状态（截至 2026-11-05 中午）

| 项 | 值 |
|---|---|
| masterdata | 商品/客户/供应商/加工厂各 5 条 + 报价 2 条，共 22 条 HTTP 端点可用。 |
| 迁移 | `0004` 商品、`0005` 客户、`0006` 供应商、`0007` 加工厂 + 报价、`0008` 库存批次 + 库存流水。 |
| inventory | 契约：批次列表/详情、库存流水共 3 条只读端点与 3 个实体；API 模块已挂载，仍返回 501。 |
| sales | 契约：订单列表/创建/详情/更新/取消共 5 条端点与 4 个实体；API 模块已挂载，仍返回 501。 |
| platform | 新增员工 create/update/disable、岗位 4 条（domain 归 `permission`）、公司 3 条；员工 3 条已实现，其余实现中。 |
| OpenAPI | `pnpm openapi` 从注册表生成，规模为 paths=30、operations=51、schemas=20；`docs/api/openapi.yaml` 勿手改。 |
| CI | 7 项：`test(ubuntu)`、`test(windows)`、`integration(PG18)`、`e2e`、`route`、`fields`、`spec-drift`。 |
| 决策 | D63 客户账期、D64 加工厂报价、D65 员工/岗位/公司口径、D66 员工实现裁定、D67 库存数量算法。 |
| 团队 | 温汇敏完成 #51；梁海俊提交 #48/#49，#48 已由 Lead 完成关闭，#49 已解封；赖皓妍邀请待接受；李祖怡未开工。 |

## 2. 已完成（不用重做）

- **masterdata**：四类档案 + 报价记录 22 条端点全部可用；迁移 `0004`–`0007` 已落地，加工厂报价按 D64 写独立子表。
- **员工管理**：PR #51 已合并，员工管理共 4 条端点接上 HTTP（原员工列表 + 新增/更新/停用 3 条），12 条测试先行；D52.1②「停用即失效」用 `computeAuthz` 每请求现算、不加缓存、不加迁移。
- **inventory 契约**：`inventory.batch.list.read` / `.detail.read` / `inventory.flow.read` 共 3 条只读端点，加批次、流水等 3 个实体；迁移 `0008` 建 `inventory_batch` + `inventory_flow`。
- **sales 契约**：`sales.order.list.read` / `.create` / `.detail.read` / `.update` / `.cancel` 共 5 条端点与 4 个实体；本批不包含完成/出库、收款记录、破下限审批。
- **platform 契约**：员工 create/update/disable 3 条已实现；岗位 4 条归 `permission` domain；公司 3 条契约已落，岗位/公司代码实现中。
- **D66 员工裁定**：停用不物理删；重复停用幂等且不自增版本；最后一个在职老板不可停，返回 403 `LAST_ACTIVE_OWNER`；D52.1② 按每请求现算落地。
- **D67 库存数量**：业务只维护四个基础列，`remaining_qty` / `available_qty` 由数据库生成列计算，应用层不得写；出库按 D41 不重复扣，流水只追加。
- **M1-F e2e**：真 PG18 → 迁移 → seed → 起 API → CLI 登录 → `/auth/me` → POST 商品 201 → 查审计断言；已进入 CI。
- **OpenAPI 治理**：生成器新增无依赖 YAML 序列化器 `packages/contracts/src/yaml.ts`；旧手工版完整保存为 `docs/api/openapi.legacy.yaml`（含 13 条未注册计划端点 + 9 条平台旧命名），仅作历史参考。
- **spec-drift**：CI 执行 `pnpm openapi` 后跑 `git diff --exit-code -- docs/api/openapi.yaml`；已在 PR #54 上真实抓到一次契约改了未重生成。

## 3. 任务板（GitHub Issues / PR）

| Issue / PR | 内容 | 当前状态 |
|---|---|---|
| #51 | 温汇敏：员工管理 4 端点接 HTTP，12 条测试先行 | ✅ 已合并 |
| #48 | 梁海俊：inventory 契约、占用字段拍板、`0008` 迁移 | ✅ Lead 已完成并关闭 |
| #49 | 梁海俊：inventory 只读实现 | OPEN；已解封，开工中 |
| #3 | 赖皓妍：成员档案落盘 | OPEN；邀请 pending |
| #4 | 登录页（P0，接口已就绪） | OPEN；前置 #3，挂起 |
| #5 | 工作台（占位数据定版式） | OPEN；前置 #3，挂起 |
| #6 | 员工页视觉骨架 + 个人权限覆盖面板 | OPEN；前置 #3，挂起 |

## 4. 下一步

1. **梁海俊领 #49**：把 inventory 3 条只读 handler 从 501 接到用例；严格使用 D67 生成列，应用层不得写数量派生列，流水只追加。
2. **platform 岗位/公司**：当前实现者续做，其他人不领同一批文件；完成后补齐对应 HTTP/权限/service 测试。
3. **sales 可交温汇敏**：#51 已完成，前提是她没有继续占用 platform 岗位/公司文件；若冲突，再交给下一位已核验且无文件冲突的后端。先实现 5 条契约端点，完成/出库、收款、破下限审批另开批次。
4. **赖皓妍前端线仍卡邀请**：她接受邀请并完成 #3 后才可领 #4/#5/#6；期间任何人不得代领。
5. **李祖怡尚未开工**：先完成身份核验和成员档案，再由 Lead 指派；当前没有可分给她的既定任务。
6. **契约改动纪律**：任何端点或字段变更先决策与契约文档，再改注册表，最后跑 `pnpm openapi`；CI 会以 spec-drift 拦截漏生成。

## 5. 坑（踩过，别再踩）

- **`main` 会被误提交**：`git switch -c <分支>` 因分支已存在而失败后，若继续 `git add/commit`，提交会落在 `main`。处理：先 `git branch -f <分支> <sha>` 把提交挂到目标分支，再 `git reset --hard origin/main`。2026-11-05 已发生两次。
- **GitHub 402 `Insufficient Balance` 可能是瞬时错误**：实测 DeepSeek 余额充足（`20.32 CNY / is_available: true`），先重试，别急着让负责人充值。
- **PGlite 可用生成列**：内存 PG18 实测支持 `STORED` 生成列及其 `CHECK`，D67 写法可在测试中使用。
- **CLI 同域末段撞名会改既有命令名**：岗位进入 `permission` 域后，`qingdan permission update` 会变成 `qingdan permission permission-update`；`sales` 域同理。
- **route-boundary 清单需手删**：`route-boundary.test.ts` 的「未挂载模块清单」是写死的，新增模块必须同步删对应行，否则测试必红。
- **派活超时补丁尚未在当前进程生效**：已改为 180 秒起体检、连续 240 秒无输出且 CPU 无增长判卡死、900 秒硬上限、卡死自动续跑一次；`IDLE_WINDOW_MS=240000` 要重启 DSH 才生效，当前进程仍是 120 秒。插件升级会丢补丁，升级后必须重打。
- **迁移与 OpenAPI 都不回写历史**：迁移只增不改；`docs/api/openapi.yaml` 由 `pnpm openapi` 生成，任何手改都会被 spec-drift 或下次生成覆盖。

## 6. 需要负责人拍板 / 补的

- 赖皓妍的 `karryL921` 邀请仍是 pending；权限落定前，#3/#4/#5/#6 无法指派，前端线不能动。
- 李祖怡尚未开工，需先完成身份核验和成员档案；未通过前不得领任务。
- `dsh-agent-conductor` 补丁需在 DSH 重启后验证 240 秒空闲窗口和自动续跑一次均按预期生效。

## 7. 交接前自检命令

```powershell
cd D:\Desktop\dsh\Qingdan
git status --short                           # 应只有 AGENTS.md / docs/HANDOFF.md / docs/roadmap.md
pwsh -NoProfile -File scripts/sync-check.ps1 # 依赖、口径、等待关系
pwsh -NoProfile -File tests\run.ps1          # exit 0 才算通过
pnpm -r test                                 # 工作区测试
pnpm openapi
git diff --exit-code -- docs/api/openapi.yaml # 生成物不得漂移
gh pr checks <PR 编号或 URL>                 # 7 项：test(ubuntu) / test(windows) /
                                             # integration(PG18) / e2e / route / fields / spec-drift
gh issue list --state open                   # 重点看 #3/#4/#5/#6/#49
```

## 8. 给新会话的开场话（可直接粘贴）

```text
接手「轻单」工程仓（D:\Desktop\dsh\Qingdan）。先读 docs/START-HERE.md 与 docs/HANDOFF.md，再按
docs/AGENT-TEAM.md 开工：DSH 拆任务/派活/验收/提交，代码交 Claude Code，杂项交 Codex。
先核验中文姓名、GitHub 账号、负责模块；三处对不上就停，未核验身份不得领任务或写代码。
每次开工前跑 pwsh -NoProfile -File scripts/sync-check.ps1；PR 须过 7 项 CI：
test(ubuntu)、test(windows)、integration(PG18)、e2e、route、fields、spec-drift。
普通改动 CI 全绿后按合并权处理；严重变更打“需批准”等负责人，不设代理人。
当前继续：梁海俊 #49 inventory 实现 + platform 岗位/公司收尾；sales 待无冲突后端接；
赖皓妍 #3/#4/#5/#6 等邀请，李祖怡等身份核验。契约变更后必须跑 pnpm openapi。
```
