# 交接说明（HANDOFF）

> **用途**：新会话接手时**第一个读的文档**。它只写「现在在哪、下一步做什么、坑在哪」，口径细节仍以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准（本文不复制口径，避免两处漂移）。
> **维护规则**：每次一段工作结束、或换会话前更新一次；过期内容直接改掉，不堆历史（历史看 `docs/roadmap.md` 变更记录）。

## 0. 一分钟读完

| 项 | 结论 |
|---|---|
| 仓库 / 阶段 | `D:\Desktop\dsh\Qingdan`，私有仓 `github.com/TianLingBy/qingdan`；当前是阶段 4 分工开发。 |
| 主线 | `platform` M1 已完成；`masterdata` 的商品、客户各 5 条 HTTP 端点已可用，其余 masterdata 端点仍为 501。 |
| 契约 | 客户、供应商、加工厂（含 2 条报价只读端点）契约已合并；加工厂报价记录表尚未建。 |
| 团队 | DSH=拆任务/验收/提交；代码→Claude Code；文档/脚本/CI→Codex。 |
| 开工入口 | 先读 `docs/START-HERE.md`，核验身份后按个人档案接活；每次开工前跑 `scripts/sync-check.ps1`。 |
| 当前阻塞 | 赖皓妍仓库邀请仍 pending；温汇敏已核验（#38）；赖皓妍、李祖怡仍待本人核验，其相关 issue 谁都不能代领。 |

## 1. 最近状态（截至 2026-11-05 上午）

| 项 | 值 |
|---|---|
| 代码 | 迁移 `0004`/`0005` 已合并；商品 5 用例 + 客户 10 用例已接 HTTP，客户/商品各 9 个 HTTP 测试。 |
| 测试基线 | `apps/api` **21 files / 160 tests**；`pnpm -r test`：contracts 76 / web 29 / cli 17 / mcp 5 / api 160。 |
| CI | 5 项：`test(ubuntu)`、`test(windows)`、`integration(PG18)`、`route`、`fields`。 |
| 契约 | 客户 5、供应商 5、加工厂 7 端点及 `Customer`/`Supplier` schema 已合并。 |
| 决策 | D63 客户账期、D64 加工厂报价记录已落档；只追加，不改历史行。 |
| 协作者 | `TianLingBy`(admin)、`Vince-Leong`、`2696708617-web`、`lozy66` 均 write；`karryL921` 邀请 pending。 |
| 身份核验 | 梁海俊 ✅；温汇敏已核验（#38）；赖皓妍、李祖怡 ⏳。未通过前不得领任务、写代码。 |
| 交接分支 | `docs/handoff-20261105`；本次只允许改 `docs/HANDOFF.md`。 |

## 2. 已完成（不用重做）

- **M0 + platform**：工程骨架、M1 认证/Token/审计/权限覆盖/员工列表已可用；D59/D60 七项审查整改已落地。
- **masterdata 商品**：`0004_masterdata_product.sql` 建 product 表（RLS、触发器、授权），本仓首次用 `updated_at` 触发器，后续业务表沿用；`repo.ts`、`usecases/products.ts`、`products.test.ts` 覆盖 5 用例；`routes.ts` 接商品 5 条 handler。
- **masterdata 客户**：`0005_masterdata_customer.sql` 建 customer 表；`customer_no` 按 D49 不加唯一/检索索引，`credit_term_days` 按 D63 加 `CHECK >= 0`。`repo-customers.ts`、`usecases/customers.ts`、`customers.test.ts` 含 10 例；`routes.ts` 再接客户 5 条 handler。
- **HTTP 测试**：`products-http.test.ts` 9 例、`customers-http.test.ts` 9 例；masterdata 其余端点仍返回 501。
- **契约**：`packages/contracts/src/customers.ts`（5 端点 + components schema）、`suppliers.ts`（5 + schema）、`processors.ts`（加工厂 5 + 报价 2；报价只增不改）。
- **决策**：D63——`creditTermDays` 为整数天、≥0、可空，0=现结、null=未定、不设上限；D64——报价落独立 `processor_quote` 子表、只增不改，按“工序+日期区间”比价，迁移从 0004 起继续追加。
- **成员入口与门禁**：`docs/START-HERE.md` 一屏开工；每份 `docs/members/<姓名>.md` 顶部有“开工提示词”。身份门禁见 `ONBOARDING.md` §0.0、`TEAM-PLAN.md` §0.2 及“身份核验 → 分工对照表”：先问中文姓名/账号/模块三问，再做成员档案、GitHub 身份、模块负责人三处交叉核对，未过就停。
- **工具与流程**：必装 6 项，gh 已降级可选；`ONBOARDING.md` §11 有 5 行“gh 命令 ↔ 网页做法”，三个 bootstrap 脚本无 gh 硬依赖。
- **合并权（2026-11-05 选 C）**：免费私有仓无分支保护、无 auto-merge（API 403 `Upgrade to GitHub Pro`）；普通改动=5 项 CI 全绿后作者网页 Squash and merge，严重变更=`需批准` 等负责人、不设代理人，详见 `ROLES-AND-BOUNDARIES.md`「合并权」。
- **跨模块同步**：`OWNERSHIP.md`（路径→负责人→通知人）+ `route-review.yml`（自动 @、scope 标签、契约/迁移/platform 打 `需批准`、校验 `Blocked by:`/`Blocks:`）+ `sync-check.ps1`（四段自检）。

## 3. 任务板（GitHub Issues，仓库里能看到）

| Issue | 内容 | 状态 |
|---|---|---|
| #3 | 赖皓妍：成员档案落盘（开工前置） | OPEN；邀请 pending，暂无法指派 |
| #4 | 登录页（P0，接口已就绪） | OPEN；应属赖皓妍，暂无法指派 |
| #5 | 工作台（占位数据定版式） | OPEN；应属赖皓妍，暂无法指派 |
| #6 | 员工页视觉骨架 + 个人权限覆盖面板 | OPEN；应属赖皓妍，暂无法指派 |
| #10 | 温汇敏：成员档案落盘 + 账号/权限域接手 | OPEN；身份核验 ⏳ |
| #15 | 商品首切契约与路由挂载 | ✅ 已关闭 |
| #14 | 梁海俊：档案落盘 + 后端接手 | ✅ 已关闭 |

## 4. 下一步

1. 供应商、加工厂的 repo + usecases + HTTP 接线，照商品/客户已经跑通的同一路径做。
2. 建加工厂报价记录表并接 2 条报价端点（D64 已定，表还没建）。
3. `openapi.yaml` 治理：先把 22 条旧 operationId 统一，再写生成脚本，最后加 CI 漂移门禁；现在直接生成会丢 54 个 component schema 和公共 Header 元数据。
4. 把 M1-F 端到端放进 CI 的 `postgres:18` job：CLI 登录 → `/auth/me` → 一次写操作 → 查审计有记录。
5. 待拍板：供应商 `suppliedMaterials` 是物料名清单还是 id 列表；`contactPhone` 是否必填；缺 If-Match 用 428 还是统一 409；软停用商品是否从列表隐式排除。

## 5. 坑（踩过，别再踩）

- **迁移不可改历史**：`0002`/`0003` 已发布；`0004+` 之后也只增不改，业务表沿用 `updated_at` 触发器。
- **`security_invoker` 视图读不了基表**：审计查询视图必须是属主权限视图 + 显式租户谓词（D59①），别改回去。
- **`TRUST_PROXY` 默认 `false`**：部署到反代后必须显式配可信网段，否则 `request.ip` 是反代地址，`ip_allowlist` 与审计 IP 都不准；反过来无脑 `trustProxy: true` 就能被 `X-Forwarded-For` 伪造（曾是被审查出的 P1）。
- **失败审计的统一 catch 在 `modules/platform/routes.ts` 外层**：用例调用必须 `return await xxx()`，否则 Promise 拒绝绕过 catch、失败日志静默丢失；已有用例自己记失败审计时要 `markFailureAuditRecorded` 去重。
- **PGlite 测试必须按文件串行**（`apps/api/vitest.config.ts`）：并行会偶发 `Hook timed out`，全量约 27 秒属正常。
- **契约变更顺序**：先 `docs/decisions.md` + 契约文档 → 再 `packages/contracts` → 最后 `apps/api`；`docs/api/openapi.yaml` 是生成物，不要手改。
- **CLI 动作名会撞**：`processor.quote.list.read` 曾与 `processor.list.read` 撞名；`packages/cli/src/cli.ts:26-40` 的 `buildActionNames` 在同域末段撞名时改用“末两段”，现已命名为 `processor.quote.read`。`registry.ts:76` 正则只允许小写，不能用驼峰前缀。
- **GitHub Actions 状态回写会卡住**：job 日志显示完成并清理，但 API/PR 页面仍可能 `queued` 十几分钟；先看 job 日志与 `gh api .../jobs` 判断真实结果，别急着重跑，状态会自行结算。
- **route-review 标签查询曾 404**（`查询标签 scope:ci 失败：Not Found`）：已改为直接 `createLabel` 并吞 409/422；再看到同类 warning 即同类问题。
- **派活超时机制已改**：180 秒起体检，连续 120 秒无输出且 CPU 不涨判卡死，900 秒硬上限，卡死自动续跑一次；已两次救回工作，子代理回复会出现“上次中断时的实现已存在”。

## 6. 需要负责人拍板 / 补的

- 赖皓妍的 `karryL921` 邀请仍 pending；在权限落定前，#3/#4/#5/#6 无法指派给她（实测指派被静默忽略）。
- 温汇敏、李祖怡的成员身份与档案仍需本人完成核验和 PR；未合并档案不能开工。
- 供应商 `suppliedMaterials` 的语义、`contactPhone` 必填性。
- 缺 If-Match 返回 428 还是统一 409；软停用商品是否从列表隐式排除。

## 7. 交接前自检命令

```powershell
cd D:\Desktop\dsh\Qingdan
git status --short                          # 本次应只有 docs/HANDOFF.md
pwsh -NoProfile -File scripts/sync-check.ps1 # 检查依赖、口径、等待关系
pwsh -NoProfile -File tests\run.ps1         # exit 0 才算通过
pnpm -r test                                # 基线：api 160 / contracts 76 / web 29 / cli 17 / mcp 5
gh pr checks <PR 编号或 URL>                # 应有 5 项：test(ubuntu)、test(windows)、integration(PG18)、route、fields
gh issue list --state open                  # 重点看 #3/#4/#5/#6/#10 当前状态
```

## 8. 给新会话的开场话（可直接粘贴）

```text
接手「轻单」工程仓（D:\Desktop\dsh\Qingdan）。先读 docs/START-HERE.md 与 docs/HANDOFF.md，再按
docs/AGENT-TEAM.md 开工：DSH 拆任务/派活/验收/提交，代码交 Claude Code，杂项交 Codex。
先核验中文姓名、GitHub 账号、负责模块；三处对不上就停，未核验身份不得领任务或写代码。
每次开工前跑 pwsh -NoProfile -File scripts/sync-check.ps1；PR 会被 route-review 自动打 scope 标签、
@ 负责人并校验 Blocked by/Blocks。普通改动须 5 项 CI 全绿后由作者网页 Squash and merge；
严重变更打“需批准”等负责人，不设代理人。派活须自包含，180 秒起体检、900 秒硬上限，子代理只写不提交。
当前继续：供应商/加工厂实现 → D64 报价表 → openapi 治理 → M1-F 端到端；待拍板项见 HANDOFF §4/§6。
```
