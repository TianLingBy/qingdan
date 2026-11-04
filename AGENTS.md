# 项目级指令（自动注入）

> 由 `@deepseek-ai/dsh-agent-instructions` 在会话首次请求时自动加载。
> 加载链：`~/.dsh/AGENTS.md`（全局）→ 本文件（项目根）→ 更深层目录的 AGENTS.md（若有）。
> 越具体越优先：本项目规则与全局冲突时，以本项目为准。

## 团队（本目录下所有会话都生效）

- 三套 harness：**DSH = 中间人/负责人**（拆任务、评估并安装所需工具、派活、验收、提交）｜**代码活 → Claude Code**｜**杂项 → Codex**；三者都接 DeepSeek。
- **生效范围**：凡 cwd 在本仓库（含 `apps/**`、`packages/**` 等子目录）新建的会话，**第一个请求起就按本文件 + `docs/AGENT-TEAM.md` 执行**，不需要用户再交代一次；用户口头指令与本文冲突时，先按本文再做，除非用户明确改规则。
- **派活方式**：`conductor_dispatch(agent:"claude-code" | "codex", task:"<自包含任务>")`；任务必须带绝对路径、写范围、依据的 D 编号、验收命令。硬规则见本文「路由」节。
- **子团队**：Claude Code 用 `.claude/agents/`（`coder` / `tester` / `reviewer`）；Codex 的 `multi_agent` 已开启。**同一文件同一时间只许一个代理写**，子代理只写不提交。
- 真源：`docs/AGENT-TEAM.md`（角色表、派活模板、技能/MCP 按需装流程、边界）。

## 项目信息

- 项目：**轻单**（工程仓）。需求稿真源仓 `D:\Desktop\dsh\轻单` 已于 2026-11-03 迁移完成后冻结为只读历史；**阶段 4 起所有开发与文档变更都在本仓**。
- 项目根：`D:\Desktop\dsh\Qingdan`（与本项目相关的会话，cwd 都应是这个目录；派发外部代理时工作目录随之固定）。
- 当前阶段：**4 分工开发**（阶段路线见 `docs/roadmap.md`）。
- 技术栈：**已定（D53/D55/D56/D57，2026-11-04）**——TypeScript 单一语言全栈（Node 24 LTS + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite + pnpm 11），`packages/contracts` 一套 Zod 注册表发射 OpenAPI 3.1 / CLI / MCP；多端（Web / Electron 桌面 / Capacitor 移动）复用同一份前端与同一套 `/api/v1`。依据 `docs/adr-0001-tech-stack.md`；U1-U5 已由 **D55** 收口、U12 spike 已由 **D57** 收口、Windows 10 兼容由 **D56** 收口。
- **工程骨架已建立（M0，2026-11-04）**：`apps/api`（Fastify 5 + Drizzle，唯一部署物）、`apps/web`（React SPA）、`packages/contracts|cli|mcp`；pnpm workspace 根 `package.json` + `pnpm-workspace.yaml` + `tsconfig.base.json` + `eslint.config.js`。业务模块固定结构 = `apps/api/src/modules/<模块>/{routes.ts,usecases/,repo.ts,schema.ts}`（`platform` 已落地作样板），**禁止跨模块 import、禁止直读他人表**。
- 测试入口：`tests\run.ps1`（PowerShell 契约测试）；TypeScript 层用 `pnpm -r build` / `pnpm -r test`（已在 `tests/workspace.test.ps1` 里包装成门禁）。
- 模块列表（新增模块时在这里登记；格式固定为“反引号模块名 → `docs/module-<模块名>.md`”，检查点测试靠它解析）：
  - `platform` → `docs/module-platform.md`
  - `masterdata` → `docs/module-masterdata.md`
  - `inventory` → `docs/module-inventory.md`
  - `purchase` → `docs/module-purchase.md`
  - `processing` → `docs/module-processing.md`
  - `sales` → `docs/module-sales.md`
  - `settlement` → `docs/module-settlement.md`
  - `internal-trade` → `docs/module-internal-trade.md`
  - `test` → `docs/module-test.md`

## 首次接入（任何 Agent）

- 第 0 步先核验「你是谁」：向带你入伙的人确认【中文姓名 / GitHub 账号 / 负责模块】，再用 `gh api user --jq .login`、`docs/members/<姓名>.md`、`docs/module-<模块>.md` 顶部「负责人」三处交叉核对；核验没过不许领任务、不许写代码（完整处置表见 `docs/ONBOARDING.md` §0.0）。
- 协作者（Claude Code / Codex / Cursor / Copilot / Gemini 等）统一读 `docs/ONBOARDING.md`，那是唯一入口。
- 能执行命令就跑 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>`（macOS/Linux：`./bootstrap.sh <模块名>`）：装 hook + 全量测试 + 建 `feat/<模块>` 分支，成功标志 `BOOTSTRAP-OK`。
- Agent 专属指针：`CLAUDE.md`、`GEMINI.md`、`.cursor/rules/qingdan.mdc`、`.github/copilot-instructions.md`——都只指向真源，不另存规则。

## 文档与真源（新会话先读 `docs/README.md`）

- **口径真源**：`docs/decisions.md`（D1-D58 已拍板；新结论只能追加，不改历史行）。
- **字段真源**：`docs/轻单_接口契约第一批_v1_20261103.md`、`docs/轻单_接口契约第二批_v1_20261103.md`（已冻结；§11 / §4 各 5 项开放项由开发阶段拍板）、`docs/轻单_接口契约第三批_v1_20261104.md`（✅ 已冻结，D54；操作日志 / API Token / 通用 API 约定）。**接口真源以 `packages/contracts` 的 Zod 注册表为准**，`docs/api/openapi.yaml` 是按 D54 对齐的描述文件。
- **原型**：`docs/prototype-v0.md`（22 页 IA、数据模型）+ `prototype.html`（可点击原型）。
- **业务事实**：`docs/轻单_业务事实问答_v1_20261103.md`（F1-F10）；决策过程：`docs/轻单_阻塞问题决策清单_v1_20261103.md`。
- **原料**：`docs/raw/` 只搬不改写，协议见 `docs/raw-protocol.md`。
- 文档状态与阅读顺序以 `docs/README.md` 为准，**不要凭记忆**。

## 阶段与检查点

- 五阶段：**1 原料搬运 → 2 上下文 → 3 原型与契约 → 4 分工开发 → 5 合并迭代**；阶段定义与当前进度只看 `docs/roadmap.md`。
- 阶段 4 起每个模块一份 `docs/module-<模块名>.md`（模板 `docs/module-template.md`），进度改记模块检查点，`roadmap.md` 只留路线与阶段状态。
- **一个工作段落结束立刻更新检查点**（一次可交付的改动 = 一个工作段落）；只在对话里说「完成了」不算留痕。
- 阶段 3 的出口（契约冻结）已完成，**契约变更必须走「先改 decisions.md 与契约文档、再改代码」**，不允许代码先行造成事实冻结。

## 开发约定

- 跨模块只走接口，**不直读对方数据表**；模块间的库存/金额数字一律以 `inventory`、`settlement` 为准。
- 权限、公司数据隔离、金额可见性（看价）**必须服务端判定**，前端隐藏不算数（D15/D27）。
- 开发到某模块的「开放项」时：先拍板 → 追加 `docs/decisions.md` → 同步改契约文档中该条的标记 → 再写代码。
- 不猜口径：未拍板的写「未定 + TODO」，不要用假设悄悄实现。
- **API-first（D52）**：业务动作先写服务层用例，再暴露 `/api/v1` REST；OpenAPI 3.1 是接口真源，Web/CLI/MCP 都是客户端，禁止只在前端实现业务逻辑。
- **审计（D51）**：每个写操作必须调用平台审计写入，产生操作日志；日志只追加、不可改删，金额按「看价」权限脱敏；AI 调用额外记 token id、来源与 reason。
- **AI 同权且不放大（D52/D52.1）**：AI 生效权限 = 绑定员工当前权限（岗位并集 ⊕ 个人覆盖 + 公司集合）∩ token scope，每请求重算、不缓存；scope 只能从创建人授权里选；员工停用/权限变更立即影响 AI；危险动作默认拒绝 AI；**审批只能由人类完成，AI 不得审批自己发起的动作**；审计同时记委托人与 AI 操作者。
- 新模块开工前读 `docs/轻单_接口契约第三批_v1_20261104.md`（操作日志 / API Token / 通用 API 约定）。

## 协作（远程仓库与分支）

- 远程：`https://github.com/TianLingBy/qingdan`（**私有**）。
- `main` 不直推：每个模块一条 `feat/<模块名>` 分支（如 `feat/platform`），走 PR 合并。
- PR 必须过 CI：`.github/workflows/test.yml` 在 `windows-latest` 与 `ubuntu-latest` 上跑 `./tests/run.ps1`，红的不合并。
- 一个 PR 只动本模块的写范围；跨模块改动（公共类型、权限、库存/金额口径）必须在 PR 描述里列受影响模块并 @ 对应负责人。
- 模块检查点 `docs/module-<名>.md` 随 PR 更新，不单独开「只改文档」的 PR。
- **合并权分级（2026-11-04 负责人拍板）**：普通 PR（文档、单模块内实现与测试、脚本/CI 微调，且 CI 三项全绿）由 Lead 直接 squash 合并，**不再逐次请示**；严重变更必须先把 PR 链接交负责人定夺——清单见 `docs/AGENT-TEAM.md` §6.1。
  > 团队成员（非 Lead）同样适用：普通改动 CI 绿后自行 squash 合并；严重变更打 `需批准` 标记等负责人。详见 `docs/ROLES-AND-BOUNDARIES.md` 的「合并权」一节。
- 协作者接入、模块认领、每模块分支与依赖顺序见 `docs/ONBOARDING.md`；**4 人人类开发者看 `docs/TEAM-PLAN.md`（分工/里程碑/DoR/DoD）与 `docs/DEV-SETUP.md`（环境/目录）**；PR 按 `.github/pull_request_template.md` 填。
- CI 跑 `windows-latest` 与 `ubuntu-latest` 两个平台，macOS/Linux 协作者以 ubuntu 结果为参照。

## 路由（三套 harness 分工，真源 `docs/AGENT-TEAM.md`）

**2026-11-04 起团队重建**：DSH 是中间人，代码活交给 Claude Code，杂项交给 Codex；三者都走 DeepSeek。

- **DSH（Lead / 中间人）**：接负责人指令 → 拆任务 → 评估并安装所需技能/MCP/联网工具 → 派活 → 跑验收 → 统一提交/开 PR → 汇报。不自己闷头写业务代码（简单改动除外）。
- **代码活 → `conductor_dispatch(agent:"claude-code")`**：实现、改代码、重构、写测试、代码审查。项目级子代理定义在 `.claude/agents/`（`coder` / `tester` / `reviewer`），它可以自建子团队。
- **杂项 → `conductor_dispatch(agent:"codex")`**：文档撰写/整理、资料整理、脚本与配置、CI、批量改名、Office 文档、环境排错。Codex 的 `multi_agent` 已开启，可以自建子团队。
- **探索性讨论、需求澄清、口径裁定** → 自己做，不派发；**联网调研**默认用 DSH 自带的 web 工具（Codex 的 `web_search` 当前关闭，需要时单次 `-c web_search="live"` 或先由 DSH 查好再给事实材料）。

派发硬规则（每次都要满足）：

1. 任务必须**自包含**（对方看不到本会话上下文）：绝对路径 + 目标 + **写范围** + 依据的 D 编号 + **验收命令** + 禁止事项。
2. 写范围写死「只允许改 X」；跨模块共享文件（`packages/contracts`、`apps/api/src/platform`、`docs/decisions.md`）未经明确授权不许动。
3. 单次派发硬超时 **180 秒**，大活拆小分次派；跑不完就拆。
4. 派发前不确定范围先 `dryRun: true` 核对 cwd 与 argv。
5. 子代理/外部代理**只写不提交**；提交、推送、开 PR 归 Lead，验收以「命令退出码 + 输出关键行」为准，不认「已完成」自述。

需要新能力（新 MCP / 新技能 / 联网）时：先说清「为什么需要、装哪、怎么卸」，装完登记到 `docs/roadmap.md`「外部依赖」表。

## 测试

- **新 clone / 新环境第一步**：`pwsh -NoProfile -File install-hooks.ps1`
  —— 把受控的 `tools/pre-commit` 装进 `.git/hooks/pre-commit`，装完立刻跑一遍全量测试。
  `.git/hooks` 不进版本控制，不装就没有任何护栏；hook 必须保持 LF（`.gitattributes` 已钉死 `tools/pre-commit text eol=lf`，否则 sh 报 bad interpreter）。
- 改完跑 `pwsh -NoProfile -File tests\run.ps1`，退出码 0 才算通过。
- 新增测试 = `tests\<模块>.test.ps1`：点源 `assert.ps1`，结尾**必须**调 `Exit-Test`。忘了调 → 脚本退出码 0，失败会被静默吞掉。
- 写完/改完 `.ps1` 必须补 BOM（`write`/`edit` 工具会丢），否则 5.1 下中文解析报错。

## 禁止事项

- 不擅自 `git init` / 删 `.git` / 改分支策略（本仓库已由主人授权初始化）。
- 不改 `D:\Desktop\dsh\轻单`（已冻结的归档仓）；需求要改就在本仓 `docs/decisions.md` 追加，并注明来源。
- 不在项目里放密钥明文；凭证只放环境变量或用户级配置。
- `docs/raw/` 里的原文不手改；要修正就回到源头并重新搬运。
- 不改 `docs/decisions.md` / 契约里已有的历史结论行：只追加、不改写（改了就无法追溯当时为什么这么定）。
