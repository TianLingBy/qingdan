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

## 1. 五个交付模块与写范围

| 交付模块 | 负责子模块 | 可写目录（代码） | 可写文档 |
|---|---|---|---|
| **MAIN 主线**（负责人 + AI 团队） | `platform`、`sales`、`settlement`、`test` 底座 | `apps/api/src/platform/**`、`.../modules/sales/**`、`.../modules/settlement/**`、`packages/contracts/**`、`packages/cli/**`、`packages/mcp/**`、`tests/**`（`run.ps1` 由 Lead 管） | `module-platform/sales/settlement/test`、契约与决策（追加） |
| **M1 基础数据与采购**（人类 1） | `masterdata`、`purchase` | `.../modules/masterdata/**`、`.../modules/purchase/**` 及对应前端页面 | `docs/module-masterdata.md`、`docs/module-purchase.md` |
| **M2 库存与盘点**（人类 2） | `inventory` | `.../modules/inventory/**` 及对应前端页面 | `docs/module-inventory.md` |
| **M3 加工与损耗**（人类 3） | `processing` | `.../modules/processing/**` 及对应前端页面 | `docs/module-processing.md` |
| **M4 内部交易与打印**（人类 4） | `internal-trade` + 打印/导出 | `.../modules/internal-trade/**`、打印版式相关前端资源 | `docs/module-internal-trade.md` |

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

**3.1 已发生的违规与判据（2026-11-07，负责人裁定）**

- **事实**：DSH Lead 见 Issue #99 没有 assignee，就自行认领，并实现了 inventory / internal-trade 两侧（PR #95/#105，decisions D73–D75），还替梁海俊往 docs/module-internal-trade.md 写了检查点。docs/TEAM-PLAN.md §0.1 早写明这两个模块归**梁海俊**。已由 PR #107 全部 revert（-1859 行），D74/D75 两行一并删除。
- **根因**：把「这些模块暂时没人动」当成「我可以动」。
- **判据（以后照此执行）**：
  1. 归属只看 docs/TEAM-PLAN.md §0 与 docs/module-<模块>.md 顶部「负责人」，**不看**「谁最近没动」；
  2. issue 没有 assignee **不等于**无主；标题里的 [inventory] 这类前缀就是归属声明；
  3. 主线只写 platform（除账号/权限域）、purchase、sales、settlement、packages/contracts、	est 底座；
  4. 确需别人模块配合（如 A 单完成要 inventory 建批次）：主线只出契约与用例，端口实现由归属模块写，先在该 issue 里留言约定，**不代写**；
  5. 一旦发现自己在写非主线目录，立即停手、回滚、报告负责人。

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

## 10. 给其他成员的智能体团队建议（可选，采不采用自定）

> **这一节是对外推荐的单真源**（团队在本仓怎么跑，见 `docs/AGENT-TEAM.md`）。你（负责人）用「DSH 中间人 + Claude Code 代码手 + Codex 杂项手」三套 harness 做主线；4 位同事**可以**照同样方式给自己配团队，也可以只用其中一套。下面是推荐做法与真实风险，收益/风险自己权衡，**采不采用**不影响本仓库的任何规则——纯人工开发同样能跑通（bootstrap / hook / CI / PR 模板都不是为 AI 特制的）。

### 10.1 推荐怎么配（最小可用）

| 角色 | 干什么 | 注意 |
|---|---|---|
| 中间人 / Lead（1 个） | 读口径与检查点、拆任务、判断缺什么工具、派活、跑验收、提交与开 PR | 只有 Lead 提交；外部 Agent 不直接 commit |
| 代码手（1 个，Claude Code） | 在自己模块的写范围内写实现与测试、做代码审查 | 用 `CLAUDE.md` + `.claude/agents/*.md`；只写不提交，自跑 build/test |
| 杂项手（1 个，Codex） | 文档整理、脚本与配置、CI、批量改名、Office、环境排错 | 用 `AGENTS.md` 当指令入口；要联网必须给沙箱开网络（见 §10.5） |

接入方式与本仓库现成能力一致：`docs/ONBOARDING.md` 一条命令初始化 → 按 `docs/module-<模块>.md` 写 → 提交前 `tests/run.ps1` → PR 模板。

### 10.2 收益（实测到的）

- **并行**：文档、测试、前端页面、契约校验可以同时推进；主线这轮 3 个子 Agent 并行产出 ADR（396 行）、OpenAPI（23 个操作）、原型两页。
- **自检强**：子 Agent 愿意跑无头浏览器、YAML 解析、$ref 断链检查这些"人懒得做"的验证（本轮实测 0 JS 异常、311 处 $ref 0 断链）。
- **上下文不中断**：长任务拆给子 Agent，主线不用扛全部上下文；每个子 Agent 只读自己需要的文档。
- **写范围好管**：一个文件只给一个 Agent，冲突面小；本轮 3 个并行者只改了 3 个文件。

### 10.3 风险（必须接受才用）

| 风险 | 说明 | 缓解 |
|---|---|---|
| 幻觉/自嗨 | 会写"已完成"但没验证 | 一切以命令输出为准；子 Agent 必须贴自检命令与输出 |
| 越界改文件 | 写范围是建议不是锁 | Lead 集成前 `git status` + diff 全量核对；越界按文件回退 |
| 契约被改坏 | AI 可能"顺手"改契约 | 契约/共享文件只允许提 PR + 人审（见 §5） |
| 上下文与成本 | 每个子 Agent 都要重读文档，慢且耗 token | 只给最小必读集；一次只派一个文件；不派"顺便看看" |
| 评审依赖人 | AI 自审不可信 | 平台层 PR 必须人类评审（§2） |
| 密钥/数据外泄 | 把凭证贴进 prompt 就进日志了 | 仓库不放密钥；凭证只走环境变量；子 Agent 不接触生产数据 |
| 团队节奏被拖 | 等 Agent 会打乱每日同步 | 设定超时：Agent 卡住 10 分钟就自己接手或换方法 |

### 10.4 建议的落地路径

1. **先试点 2 天**：挑一个边界清晰的小任务（例如给自己的模块补 3 条契约测试），看产出质量与耗时。
2. **只给写范围**：每次派活写死"只允许改哪些文件、不许 commit"。
3. **人做提交闸门**：子 Agent 只写，Lead 跑测试后统一提交。
4. **强制人审**：自己审或请另一位同事审，AI 不能自己批自己。
5. **一周复盘**：算一下"省了多少时间 / 多花了多少评审时间"，决定是否继续。
6. **不采用也完全 OK**：所有文档、钩子、CI、PR 模板对纯人工开发一样适用，没有任何强制依赖。

### 10.5 可抄走的坑（2026-11-04 M0 骨架实测）

- 外部 CLI 单次派发有**硬超时**（本机设 180 秒）：大活必须拆小，否则被杀掉只拿到半截。
- `pnpm` 新版本默认**禁止依赖执行安装脚本**，需要显式白名单（本仓放行 `esbuild`）。
- 工具链最新版可能跑在生态前面：TypeScript 7 与 typescript-eslint 不兼容 → 降到 6 才通过。
- Codex 的 `web_search` 开关在非 OpenAI provider 下**不产生搜索工具**（实测）；让它联网要给沙箱开网络：`[sandbox_workspace_write] network_access = true`。
- 沙箱内 `curl.exe` 可能 `EPERM`，换 `Invoke-WebRequest` 一类通道通常能通。
- **同一文件同一时间只许一个代理写**；子代理只写不提交，验收只认命令退出码与真实输出行。
- 派活前把"绝对路径 + 目标 + 写范围 + 依据 + 验收命令 + 禁止事项"写成模板，外部 Agent 看不到你的对话上下文。

**不要外带的东西**：私有口径与决策编号、接口契约内容、密钥与环境变量值、客户与业务数据。结构可以抄，业务内容请换成你自己的。

## 合并权（2026-11-05 负责人拍板）

本仓是免费私有仓，分支保护与原生 auto-merge 不可用（实测 API 403 `Upgrade to GitHub Pro`），因此靠规则 + CI 兜底，不搞自动合并。

- **普通改动**：CI 三项全绿后，作者自行使用网页 **Merge pull request → Squash and merge**（有 gh 也可 `gh pr merge <号> --squash`）合并，不需要负责人审批或在线；合并后删除分支。
- **严重变更**：契约与口径 / 数据与内核（迁移、schema、RLS、platform）/ 权限与可见性 / 不可逆或影响他人 / 跨模块共享 / 需要人工回滚的发布脚本。
- 严重变更须在 PR 上打 `需批准` 标记，并在 issue/PR 里 @TianLingBy，等负责人批准；**不设代理人**。
- **通知**：GitHub 仓库 **Watch → Participating**，并开启邮箱通知；PR 与 @ 会通过邮件送达。
