# 轻单 · 分工与边界（谁能做什么、不能做什么）

> **读者**：项目负责人、AI 开发线（我 + 子 Agent）、4 位人类协作开发者。
> **一句话**：**写范围互斥、共享文件走 PR、口径只由负责人拍板**。本文是"能做/不能做"的最终清单，与 `docs/TEAM-PLAN.md`（排期）配套。
> **注意**：本文讲的是**开发者分工边界**；应用里员工/老板的权限是产品能力，见 `docs/decisions.md` D4 / D15 / D50 / D52.1，不要混。

---

## 0. 谁能做什么（一页纸）

| 角色 | 能做 | 不能做 |
|---|---|---|
| **负责人（你）** | 定范围与优先级、拍板口径（decisions）、选定技术栈、加人/授权、验收、最终合并权 | 不需要亲自写代码；但不经评审直接改 `main` 的代码也不会被接受 |
| **Lead（我）** | 统筹排期、写/维护契约与共享文档、维护 `packages/contracts` 与 platform、提交 AI 线代码、评审、跑测试、统一发布 | 不替人类线写他们负责的模块（避免抢活与冲突）；不跳过评审自己合并自己的 PR |
| **AI 线（子 Agent）** | 只在被分配的那一个文件/目录内写；完成后报告改动与自检结果 | **不提交、不推送、不改别人的文件、不改共享文档、不改口径** |
| **人类线 1-4** | 写自己模块的代码/测试/检查点；提 PR 改共享文件；评审别人的 PR | 不直接 push `main`；不改别人的模块；不绕过 CI 与评审 |

---

## 1. 五条开发线与写范围

| 开发线 | 负责模块 | 可写目录（代码） | 可写文档 |
|---|---|---|---|
| **AI 线** | `platform`、`test` 底座 | `apps/api/src/platform/**`、`packages/contracts/**`、`packages/cli/**`、`packages/mcp/**`、`tests/**`（`run.ps1` 除外） | `docs/module-platform.md`、`docs/module-test.md`、契约与决策（追加） |
| **人类线 1** | `masterdata`、`purchase` | `apps/api/src/modules/masterdata/**`、`.../purchase/**`、`apps/web/src/pages/masterdata/**`、`.../purchase/**` | `docs/module-masterdata.md`、`docs/module-purchase.md` |
| **人类线 2** | `inventory`、`processing` | `.../modules/inventory/**`、`.../processing/**` 及对应前端页面 | `docs/module-inventory.md`、`docs/module-processing.md` |
| **人类线 3** | `sales`、`internal-trade` | `.../modules/sales/**`、`.../internal-trade/**` 及对应前端页面 | `docs/module-sales.md`、`docs/module-internal-trade.md` |
| **人类线 4** | `settlement`（含利润报表） | `.../modules/settlement/**` 及对应前端页面 | `docs/module-settlement.md` |

> `apps/api/src/platform/**` 与 `packages/contracts/**` 是**共享写范围**：AI 线独占维护，人类线要改只能提 PR。

---

## 2. 能做（每个角色的正面清单）

### 2.1 人类开发者（每天都会用）

- 在自己模块分支上写代码、写测试、跑 `tests/run.ps1`、提交、push、开 PR。
- 读任何文档与代码；在 Issue/PR 里提问题、提建议。
- 给自己的模块加测试文件（`tests/<模块>.test.ps1`）。
- 提 PR 修改共享文件（contracts / platform / 文档 / CI），但必须写清影响面并等评审。
- 评审别人的 PR（1 次 approve 即算数）。
- 在模块检查点 `docs/module-<模块>.md` 记录进度、坑、下一步。

### 2.2 AI 线（子 Agent 与 Lead）

- 子 Agent：在任务声明的**单个文件/目录**内写；完成后自检并报告；**不提交**。
- Lead：写共享文档、维护 contracts/platform、跑测试、按文件分次提交、开 PR、发布。
- 任何 AI 线的产出都必须经过「CI 绿 + 人类评审」才进 `main`。

### 2.3 负责人

- 拍板 `docs/decisions.md`（只追加）、选技术栈、定里程碑、加协作者、最终验收。

---

## 3. 不能做（红线，违反就退回）

| # | 红线 | 为什么 | 怎么发现/拦 |
|---|---|---|---|
| 1 | 不直接 push `main` | 保护主干可回滚 | 分支保护不可用（免费私有仓），靠约定 + CI + 评审 |
| 2 | 不改别人负责的模块/文档 | 写范围互斥，避免互相踩 | git diff 评审 + 模块检查点负责人 |
| 3 | 不直接改 `packages/contracts`、`apps/api/src/platform` | 一处改错，五个模块一起错 | 只能 PR + 影响面 + 评审 |
| 4 | 不改 `docs/decisions.md` 历史结论行（只追加） | 失去"当时为什么这么定"的追溯 | diff 评审；新结论必须新行 |
| 5 | 不改已冻结契约的结论（第一/二批）；第三批冻结后同理 | 代码会按旧契约写 | 变更走「决策 → 契约 → 代码」 |
| 6 | 不手改 `docs/raw/` | 原文不可追溯 | requirements 测试 + 评审 |
| 7 | 不 `git commit --no-verify`、不绕过/删除测试、不放宽 CI 门槛 | 护栏一旦失效就没人知道 | hook + CI + 评审 |
| 8 | 不跨模块 import、不直读别人的数据表 | 模块边界一破就回到大泥球 | ESLint `no-restricted-imports` + 评审 |
| 9 | 不私自加依赖、换技术栈、改目录结构 | 影响全组与部署 | 依赖变更需 Lead 同意并记录 |
| 10 | 不在仓库放密钥/真实手机号/真实客户数据 | 泄露不可逆 | 提交前扫描 + 评审 |
| 11 | 不擅自改冻结归档仓 `D:\Desktop\dsh\轻单` | 历史真源 | AGENTS 规则 |
| 12 | AI 子 Agent 不直接提交/推送 | 提交必须可追溯、可回退 | 只有 Lead 提交 |
| 13 | 不把"未验证"写成"已完成" | 会让负责人误判 | DoD + 评审 |
| 14 | 不把 AI 的权限设得比人类高（产品规则） | 违背 D52.1 | platform 的 scope 校验 + 测试 |

---

## 4. 需要批准才能做（灰区，先问再做）

| 动作 | 需要谁批 | 流程 |
|---|---|---|
| 新增页面/功能 | 负责人 | 先写进 `decisions.md`，再改原型与契约，再写代码 |
| 数据库迁移（加表/改列） | Lead + 受影响模块负责人 | PR 里写清前向迁移与回滚方案 |
| 新增第三方依赖 | Lead | 说明用途/体积/许可证，记录在 PR |
| 修改测试断言 | Lead | 说明"原断言为什么错"，附新用例 |
| 改 CI / 分支策略 / 钩子 | Lead | 单独 PR，说明影响 |
| 发布 / 部署 / 改线上配置 | 负责人 + Lead | 走发布清单，回滚演练 |
| 改 `packages/contracts` 的公开类型 | Lead + 全部受影响线 | 先发变更 Issue，再 PR |

---

## 5. 文件级「谁能写」矩阵

| 文件/目录 | 谁能直接写 | 其他人怎么改 |
|---|---|---|
| `apps/api/src/modules/<模块>/**` | 对应开发线 | 提 PR + 评审 |
| `apps/api/src/platform/**` | AI 线 | 人类线只能提 PR |
| `packages/contracts/**` | AI 线 | 人类线只能提 PR（附影响面） |
| `apps/web/src/pages/<模块>/**` | 对应开发线 | 提 PR |
| `tests/<模块>.test.ps1` | 对应开发线 | 提 PR |
| `tests/run.ps1`、`tests/assert.ps1`、`tests/*contract*` | Lead | 提 Issue |
| `docs/module-<模块>.md` | 对应开发线 | 提 PR |
| `docs/decisions.md` | Lead（追加） | 人类提 Issue/PR 建议 |
| 契约三批文档 | Lead | 提 PR（冻结后需版本递增） |
| `AGENTS.md`、`README.md`、`ONBOARDING.md`、`TEAM-PLAN.md`、本文 | Lead | 提 Issue |
| `prototype.html` | Lead / 原型负责人 | 提 PR |
| `.github/**`、`bootstrap.*`、`install-hooks.ps1` | Lead | 提 Issue |
| `docs/raw/**` | 谁都**不能**手改 | 只能重新搬运 |

---

## 6. 冲突与仲裁（按这个顺序处理）

1. **文件冲突**：同一文件只允许一条线在同一时段写；发现冲突先停，报 Lead 协调。
2. **接口不一致**：以 `packages/contracts` 与冻结契约为准；契约本身有问题 → 提 Issue，Lead 拍板后改契约再改代码。
3. **口径不一致**：查 `docs/decisions.md`；查不到 → 在 Issue 写「需要拍板：问题 + 两个候选」，由负责人拍板，**不许自己发明**。
4. **依赖没就绪**：不要写 mock 业务逻辑蒙混；在检查点写「被 X 阻塞 + 需要的接口签名」，先去写不依赖的部分（用例/状态机/测试清单）。
5. **评审僵持**：Lead 裁决；涉及产品口径的由负责人裁决。

---

## 7. 违规怎么处理

1. 发现越界：先**按文件回退**（`git checkout <file>` / revert 单个提交），不整体回滚别人的工作。
2. 记录到 PR/Issue：谁、改了哪个文件、为什么不行。
3. 重复越界：该线降为「只能提 PR，不能直接 push」。
4. 自动化能拦的：hook（测试）、CI（双平台）、ESLint（跨模块 import）、`requirements/onboarding/team-docs` 契约测试（文档缺失）。
5. 自动化拦不住的（越界改别人文件、绕评审）：靠 Lead 每次集成前的 `git status` + diff 全量核对；这条要一直保留。

---

## 8. 与"产品权限"的区别（避免混用）

| 概念 | 文档 | 管什么 |
|---|---|---|
| **开发分工边界** | 本文 + `TEAM-PLAN.md` | 谁能改哪些文件、走什么评审 |
| **产品内角色权限** | `decisions.md` D4 / D15 / D50 | 应用里老板/经理/员工能看什么、能操作什么 |
| **AI 调用权限** | `decisions.md` D52 / D52.1 + 契约第三批 | AI 的 token 能做什么、不能超过谁 |

---

## 9. 一页速查

- 我负责的模块 → 我能直接写；别人的 → 只能提 PR。
- 共享文件（contracts/platform/decisions/CI）→ 先问 Lead。
- 口径问题 → 查 decisions；查不到 → 提 Issue，等负责人拍板。
- 提交前 → `pwsh -NoProfile -File tests\run.ps1` 绿；不绿不许提交。
- 交付 → PR + CI 绿 + 1 人评审 + 检查点更新。
- 不确定能不能做 → 先问，不要先做。
