# 项目级指令（自动注入）

> 由 `@deepseek-ai/dsh-agent-instructions` 在会话首次请求时自动加载。
> 加载链：`~/.dsh/AGENTS.md`（全局）→ 本文件（项目根）→ 更深层目录的 AGENTS.md（若有）。
> 越具体越优先：本项目规则与全局冲突时，以本项目为准。

## 项目信息

- 项目：**轻单**（工程仓）。需求稿真源仓 `D:\Desktop\dsh\轻单` 已于 2026-11-03 迁移完成后冻结为只读历史；**阶段 4 起所有开发与文档变更都在本仓**。
- 项目根：`D:\Desktop\dsh\Qingdan`（与本项目相关的会话，cwd 都应是这个目录；派发外部代理时工作目录随之固定）。
- 当前阶段：**4 分工开发**（阶段路线见 `docs/roadmap.md`）。
- 技术栈：**未定**——`platform` 模块开工前必须出 ADR 并追加 `docs/decisions.md` D53。
- 测试入口：`tests\run.ps1`。
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

- 协作者（Claude Code / Codex / Cursor / Copilot / Gemini 等）统一读 `docs/ONBOARDING.md`，那是唯一入口。
- 能执行命令就跑 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>`（macOS/Linux：`./bootstrap.sh <模块名>`）：装 hook + 全量测试 + 建 `feat/<模块>` 分支，成功标志 `BOOTSTRAP-OK`。
- Agent 专属指针：`CLAUDE.md`、`GEMINI.md`、`.cursor/rules/qingdan.mdc`、`.github/copilot-instructions.md`——都只指向真源，不另存规则。

## 文档与真源（新会话先读 `docs/README.md`）

- **口径真源**：`docs/decisions.md`（D1-D52 已拍板；新结论只能追加，不改历史行）。
- **字段真源**：`docs/轻单_接口契约第一批_v1_20261103.md`、`docs/轻单_接口契约第二批_v1_20261103.md`（已冻结；§11 / §4 各 5 项开放项由开发阶段拍板）、`docs/轻单_接口契约第三批_v1_20261104.md`（🟡 草案，platform 开工前冻结；操作日志 / API Token / 通用 API 约定）。
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
- 模块检查点 `docs/module-<名>.md` 随 PR 更新，不单独开「只改文档」的 PR；合并前至少一次人工评审（或 `claude-code` 做第二意见）。
- 协作者接入、模块认领、每模块分支与依赖顺序见 `docs/ONBOARDING.md`；PR 按 `.github/pull_request_template.md` 填。
- CI 跑 `windows-latest` 与 `ubuntu-latest` 两个平台，macOS/Linux 协作者以 ubuntu 结果为参照。

## 路由（引用全局，不重复定义）

全局 `~/.dsh/AGENTS.md` 的「多智能体路由」已规定：

- 深度编码、代码审查、架构第二意见 → `conductor_dispatch(agent:"claude-code")`
- 边界清晰、可验证的实现类任务 → `conductor_dispatch(agent:"codex")`
- 探索性讨论、需求澄清、写文档 → 自己做，不派发

项目内追加两条：

- 派发任务的提示里必须写项目根的绝对路径，并说明「只改本模块相关文件」。
- 派发前若不确定范围，先 `dryRun: true` 核对 cwd 与 argv。

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
