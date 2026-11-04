# 轻单 · 协作者一键接入（任何 Agent 通用）

> **这是唯一入口。** 不管协作者用的是 Claude Code / Codex / Cursor / GitHub Copilot / Gemini CLI 还是别的 Agent，都先读这一份，再按 §2 跑一次初始化。
> 规则真源永远是 `AGENTS.md` + 本文件；下面 §8 那些 Agent 专属文件只是指针。

## 0. 完成定义（怎样算「初始化好了」）

一次接入做完，应该同时满足这五条：

1. `tests\run.ps1` 能跑、全绿；
2. `.git/hooks/pre-commit` 已装（提交前自动跑测试）；
3. 已在自己负责模块的分支上（`feat/<模块名>`）；
4. 模块检查点 `docs/module-<模块名>.md` 的「当前状态」已认领；
5. 知道自己下一步写什么（模块的「开放项 + 验收标准」）。

## 0.1 人类开发者请走这条线

如果你是被邀请来的**人类协作开发者**（本项目 4 人小组），除了本文件，还必须读这两份：

1. `docs/ROLES-AND-BOUNDARIES.md` —— 谁能做什么、不能做什么、灰区谁批、文件级写权限（先看这份，避免越界）。
2. `docs/TEAM-PLAN.md` —— 你负责哪几个模块、第 1 周具体做什么、DoR/DoD、人机互评与升级规则。
3. `docs/DEV-SETUP.md` —— 本机环境（Node 24 / pnpm 11 / PostgreSQL 18）、仓库骨架与目录边界、本地起服务、测试分层。
4. `docs/members/README.md` —— **成员档案规则**：先确认身份、再领任务，**必须把自己的档案 `docs/members/<姓名>.md` 落盘并提交 PR**，档案没合并等于没开工。

技术栈已拍板 **D53 = TypeScript 全栈**（Node 24 + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite），详见 `docs/adr-0001-tech-stack.md`。

**开工顺序（不可颠倒）**：确认身份 → 落盘成员档案 → 在 `docs/module-<模块>.md` 登记负责人 → 领任务 → 才动代码。

## 1. 硬前置：先装软件，再 clone

**必装 7 项**（完整版本依据、下载地址、验证命令见 [`docs/DEV-SETUP.md`](DEV-SETUP.md) §1「必装软件清单」）：

| # | 软件 | 命令名 | 版本 | 下载 |
|---|---|---|---|---|
| 1 | Git（Windows 用 Git for Windows，勾选 Git Credential Manager） | `git` | ≥ 2.40 | <https://git-scm.com/download/win> |
| 2 | GitHub CLI | `gh` | ≥ 2.60 | <https://cli.github.com/> |
| 3 | Node.js | `node` | **24 LTS（24.x）** | <https://nodejs.org/en/download> |
| 4 | pnpm | `pnpm` | **11.x** | `corepack enable` 或 `npm i -g pnpm@11.28.10` |
| 5 | PowerShell 7（**不是**系统自带 `powershell` 5.1） | `pwsh` | ≥ 7.0 | <https://aka.ms/powershell-release?tag=stable> |
| 6 | PostgreSQL | `psql` | **18** | <https://www.postgresql.org/download/windows/> |
| 7 | 编辑器（建议 VS Code + ESLint/Prettier 插件） | — | 任意 | <https://code.visualstudio.com/> |

**权限前置**：仓库是私有的，你的 GitHub 账号必须已被负责人加为 **write** 协作者并**接受邀请**，否则 `git clone` 会报 **404 / Repository not found**（GitHub 对无权限账号统一返回 404，不是 403）。

装机后逐条验证（全过才进 §2）：

```powershell
node -v                 # v24.x
pnpm -v                 # 11.x
git --version           # 2.4x+
gh --version            # 2.6x+
pwsh -v                 # 7.x —— 在 5.1 里跑这行会报错，正说明你没装 PS7
gh auth login           # 浏览器登录「被邀请的那个」GitHub 账号
gh api user --jq '.login'                          # 确认当前身份
gh api repos/TianLingBy/qingdan --jq '.permissions' # 期望 push:true；404 见下
```

- 没有 pwsh 7 时：Windows `winget install --id Microsoft.PowerShell -e`；macOS `brew install --cask powershell`；Ubuntu 走微软官方 apt 源。**不要用 5.1 兜底**——本仓 `.ps1` 带 BOM，但 5.1 仍会在部分场景按 GBK 解码中文报 `The string is missing the terminator`。
- `gh api repos/TianLingBy/qingdan` 报 **404**：说明当前登录的账号不是被邀请的那个。依次做 `gh auth login`（换账号）→ `cmdkey /delete:git:https://github.com`（清 Windows 旧凭据）→ 仍不行就把 `gh api user --jq '.login'` 的输出发给负责人核对，需要时用正确账号重发邀请。

## 2. 一键初始化（推荐，所有 Agent 都能照抄）

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan

# 只做环境（装 hook + 跑全量测试）
pwsh -NoProfile -File bootstrap.ps1

# 环境 + 建自己的模块分支（取下面 §4 表格里的模块名）
pwsh -NoProfile -File bootstrap.ps1 -Module platform
```

macOS / Linux：

```bash
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
./bootstrap.sh                 # 只做环境
./bootstrap.sh platform        # 环境 + 建 feat/main-platform 分支
```

脚本做的事（**幂等，可以重复跑**）：
① 校验在仓库根 → ② 校验 pwsh 7 / git → ③ 调 `install-hooks.ps1` 装 hook 并跑全量测试 → ④ 带 `-Module` 时校验模块存在并建/切**交付分支**（如 `masterdata` → `feat/m1-masterdata`，映射见 `docs/TEAM-PLAN.md` §0） → ⑤ 打印认领清单与必读顺序。

成功标志：最后一行是 `BOOTSTRAP-OK`。

## 3. 手动版（Agent 不能执行脚本时，逐条照做）

```powershell
pwsh -NoProfile -File install-hooks.ps1      # 装 hook，并自动跑一遍测试
pwsh -NoProfile -File tests\run.ps1          # 再跑一次，确认 ALL PASSED (N files)
git switch -c feat/<模块名>                  # 建分支（已存在就 git switch feat/<模块名>）
```

然后打开 `docs/module-<模块名>.md`，把「当前状态」改成：`进行中（<你的名字>，YYYY-MM-DD）`。

## 4. 分工与分支

功能域按「原单方向」归模块（D44 的 R/S/I 不单独立模块）：R 归 sales、S 归 purchase、I 归 inventory。

> **交付模块划分（定稿）**：主线（platform/sales/settlement）+ M1 主数据与采购 + M2 库存与盘点 + M3 加工与损耗 + M4 内部交易与打印，负责人与写范围见 `docs/TEAM-PLAN.md` §0/§1；下表是**代码子模块**与分支名，具体归哪条交付模块看 §0。

| 模块（分支名） | 负责范围 | 依赖 | 负责人 |
|---|---|---|---|
| `platform`（`feat/platform`） | 登录/入企、租户·公司·员工、权限引擎（D4/D15/D50）、编号（D16/D48）、审批、单据框架（三态/取消级联）、待办流转、打印导出框架、链路视图、**操作日志（D51）**、**API 与集成（D52：OpenAPI/CLI/MCP/API Token/危险动作开关）**、平台运营后台 | 无（P0，所有模块都等它） | 待认领 |
| `masterdata`（`feat/masterdata`） | 商品、客户、供应商、加工厂 | platform | 待认领 |
| `inventory`（`feat/inventory`） | 批次（锁价/占用/可用量/保管人）、库存数量、库存流水、盘点调整 I、成本更正 T1/T2/T3 | platform、masterdata | 待认领 |
| `purchase`（`feat/purchase`） | A 采购单、S 供应商退货 | platform、masterdata、inventory | 待认领 |
| `processing`（`feat/processing`） | B 加工单、损耗、全损耗损失记录、归属单 | platform、masterdata、inventory | 待认领 |
| `sales`（`feat/sales`） | E 销售单、改价下限审批、收款记录、客户在线支付、R 客户退货 | platform、masterdata、inventory | 待认领 |
| `internal-trade`（`feat/internal-trade`） | N 内部交易单、内部定价、在途锁定/签收转司 | platform、masterdata、inventory | 待认领 |
| `settlement`（`feat/settlement`） | C 结算单、提成、利润报表 | sales、processing、internal-trade | 待认领 |
| `test`（`feat/test`） | 测试底座与契约测试（通常由平台负责人兼） | 无 | 待认领 |

**开工顺序**：platform →（masterdata ∥ inventory）→（purchase ∥ processing）→（sales ∥ internal-trade）→ settlement。
依赖没就绪时**不要开工**，先在自己的检查点里写「被 X 阻塞 + 需要的接口签名」，等对方合入。

约定：

- **一个模块一个负责人**；一个 PR 只碰本模块写范围。
- 跨模块改动（公共类型、权限、库存/金额口径、`docs/decisions.md`）必须在 PR 描述里列受影响模块并 @ 对应负责人。
- `main` 不直推（免费私有仓无法强制保护，靠 CI 红不合并 + 评审约定兜底）。
- 合并前至少一次评审；AI 做第二意见可以用 `claude-code`。

## 5. 必读文档（最小集，约 15 分钟）

按顺序读，不要通读 41KB 的 `decisions.md`：

1. `docs/README.md` —— 文档索引与模块表（5 分钟，知道什么在哪儿）。
2. `docs/module-<你的模块>.md` —— 你的边界、依赖、开放项、验收标准（最重要）。
3. `docs/decisions.md` §1 —— **只读你模块检查点「相关文件」列出的 D 编号**。
4. 对应契约章节：`docs/轻单_接口契约第一批_v1_20261103.md`（A/B/E/C + 批次 + 流水）或 `第二批`（N + 提成 + 定价）；**platform 另读 `docs/轻单_接口契约第三批_v1_20261104.md`（操作日志 / API Token / 通用 API 约定，草案待冻结）**。
5. `docs/prototype-v0.md` §2 —— 你模块对应页面的职责与状态。

**不需要读**：`docs/raw/`（飞书原文，追溯时才用）、`轻单_阻塞问题决策清单`（讨论过程，结论已在 decisions）、`project-context.md`（除非你要动架构/部署）。

## 6. 干活与交付（DoD）

1. **开放项先拍板**：模块检查点「开放项」里的每一条，开工前定下来 → 追加到 `docs/decisions.md`（只追加，不改历史行）→ 同步改契约里该条的标记 → 再写代码。
2. **不猜口径**：没拍板的写 `TODO(未定)`，不要用假设悄悄实现。
3. **每周/每段落更新检查点**：`docs/module-<模块名>.md` 的已完成 / 进行中 / 下一步 / 坑。
4. **提交前**：`pwsh -NoProfile -File tests\run.ps1` 必须 exit 0；hook 会自动再跑一次。
5. **开 PR**：按 `.github/pull_request_template.md` 填，CI（GitHub Actions）绿了再找人评审。
6. **合并后**：删本地分支，从 `main` 重新拉下一段。

## 7. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `pre-commit: 找不到 pwsh` | PATH 上没有 PS7 | 装 pwsh 7；hook 会报错阻止提交，不会静默放行 |
| `The string is missing the terminator` | 用 5.1 跑了带中文的 `.ps1` | 一律 `pwsh`；新写的 `.ps1` 必须带 BOM |
| `/bin/sh: ./pre-commit: bad interpreter` | hook 被转成 CRLF | `.gitattributes` 已钉 LF；重跑 `install-hooks.ps1` |
| 测试红 | 改了契约/检查点断言 | 先看 `tests\run.ps1` 报哪个文件哪条断言；**不要 `--no-verify` 绕过** |
| `403` / 无权推送 | 没被邀请进私有仓 | 找仓库所有者加协作者（write 权限） |
| `bootstrap.ps1` 报模块不存在 | 模块名拼错 | 用 §4 表格里的名字，全小写、连字符 |
| Agent 说「GitHub MCP 未配置」/ 看不到 PR 与 issue | 客户端没配 GitHub MCP，只能靠 `gh` 命令行 | 按 §8.1 配一次；配完让 Agent 列一次开放 PR 自检 |

## 8. 各 Agent 的入口对照

| Agent | 先读的文件 | 说明 |
|---|---|---|
| Claude Code | `CLAUDE.md` | 指向本文件与 `AGENTS.md` |
| Codex | `AGENTS.md` | 项目规则主体 |
| Cursor | `.cursor/rules/qingdan.mdc` | `alwaysApply` 规则，指向本文件 |
| GitHub Copilot | `.github/copilot-instructions.md` | 指向本文件 |
| Gemini CLI | `GEMINI.md` | 指向本文件 |
| 其他 / 自定义 Agent | `AGENTS.md` → 本文件 | 规则真源，不要只读指针文件 |

**给 Agent 的一句话指令**（可直接粘贴给任意 Agent）：

> 克隆 https://github.com/TianLingBy/qingdan.git 到本地，读仓库根的 AGENTS.md 与 docs/ONBOARDING.md，运行 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>` 完成初始化；然后按 docs/module-<模块名>.md 的开放项与验收标准开始开发，提交前跑 `tests\run.ps1`。

## 8.1 GitHub MCP：让 Agent 直接读写 issue / PR（协作必配）

**为什么**：不配的话，Agent 只能一条条敲 `gh` 命令，或者反过来问你「PR 号是多少」。配好之后它能自己列 PR、读 diff、发评论、改 issue 状态。**Agent 报「GitHub MCP 未配置 / 我这边没有 github 工具」就是这一步没做**——不是权限问题，是客户端没装。

**第 1 步：确认 `gh` 登录的是被邀请的那个账号**

```powershell
gh auth status                                        # 期望：Logged in to github.com account <你的账号>
gh api repos/TianLingBy/qingdan --jq '.permissions.push'   # 期望：true
```

**第 2 步：把 token 放进用户环境变量（不进仓库）**

```powershell
setx GITHUB_PAT (gh auth token)   # 取 gh 自己那份 OAuth token；关掉并重开终端后生效
$env:GITHUB_PAT.Length -gt 20     # 重开终端后验证，期望 True
```

- **变量名别用 `GITHUB_TOKEN`**：部分宿主（含 DSH）给子进程传环境变量时会剥掉名字里含 `KEY` / `SECRET` / `TOKEN` 的变量，`GITHUB_PAT` 不受影响。
- 要最小权限就改用 fine-grained PAT：只选 `qingdan` 一个仓库，权限给 Issues: Read and write、Pull requests: Read and write、Contents: Read、Metadata: Read。
- **token 不进仓库、不进聊天记录、不写进任何文档**；一旦泄露立刻去 GitHub 撤销重发。

**第 3 步：按你的客户端配一次**（端点固定 `https://api.githubcopilot.com/mcp/`）

Claude Code：

```powershell
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer $env:GITHUB_PAT" --scope user
claude mcp list
```

Codex：

```powershell
codex mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-token-env-var GITHUB_PAT
codex mcp list
```

Cursor / VS Code Copilot：写项目级配置（Cursor 是仓库根的 `.cursor/mcp.json`）：

```json
{"mcpServers":{"github":{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${env:GITHUB_PAT}"}}}}
```

**第 4 步：验收到位（三条都要过）**

1. `claude mcp list` / `codex mcp list` 里出现 `github`，状态不是 `failed`；
2. 让 Agent 执行一次「列出本仓开放 PR」，能返回列表 → 说明私有仓读得到、token 有权限；
3. 把 `GITHUB_PAT` 清空再试一次，应当报错 → 说明它真的在用 token，不是匿名访问。

**排查**

| 现象 | 原因 | 处置 |
|---|---|---|
| 401 / `Bad credentials` | token 没进到客户端进程 | 重开终端；核对变量名；`claude mcp list` 看是否 `failed` |
| 403 / 读不到私有仓 | 登录的不是被邀请的账号 | `gh api user --jq '.login'` 与负责人核对 |
| 连接超时 | 到 `api.githubcopilot.com` 不通（本机直连 GitHub 不稳） | 换网络/代理；或改用本地 Docker 版 `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN=<PAT> ghcr.io/github/github-mcp-server`，按 stdio 方式配 |
| 用 `curl` 试连通性报 `SEC_E_NO_CREDENTIALS` | Windows schannel 的已知问题，**不是**网络不通 | 别用 curl 验，用客户端自身验 |

**Agent 用它时必须守的边界**（与 §10.3 铁律一致）：只读写本仓的 issue / PR / 评论；不改分支保护、不改仓库设置、不删仓库、不读别人的仓。**提交代码仍然走 `git` + PR**，不用 MCP 直接改文件。

**本节验证记录**：2026-11-04 用 `gh auth token` 对 `https://api.githubcopilot.com/mcp/` 发 MCP `initialize`，返回 HTTP 200 与 `serverInfo`（Node 24 `fetch`）；同机 `curl` 报 `SEC_E_NO_CREDENTIALS`，所以「curl 不通」不能证明端点不可用。

## 9. 卡住时找谁

- 仓库所有者 / 总负责：`TianLingBy`（GitHub）。
- 口径问题：先查 `docs/decisions.md`；查不到就在 PR 说明里写「需要拍板：问题 + 两个候选方案」，不要自己发明。
- 提 issue / PR 时写清：模块名 + 执行过的命令 + 完整报错输出。

## 10. 给成员（及他们的 Agent）的开局指令

### 10.1 前提（缺一不可，先由仓库所有者做）

1. **仓库是私有的**：所有者必须在 GitHub → Settings → Collaborators 里把成员的 GitHub 账号加为 **write** 权限（否则 `git push` 403）。
2. **本机环境**：Git、PowerShell 7（`pwsh`，5.1 不行）、Node 24、pnpm 11。缺 Node 24 时 `bootstrap.ps1` 会提示。
3. **不要用共享 token**：每个人用自己的 GitHub 账号登录（`gh auth login` 或 Windows 凭据管理器），**不要把 PAT 写进文档、聊天记录或仓库**。
4. **给 Agent 配好 GitHub MCP**：没配的话 Agent 读不到 issue / PR，只能靠你人工转述（配置方法见 §8.1）。

### 10.2 三条命令（人类自己敲）

```powershell
git clone https://github.com/TianLingBy/qingdan.git D:\Work\qingdan
cd D:\Work\qingdan
pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>    # 模块名见 §4，成功标志 BOOTSTRAP-OK
```

### 10.3 复制给对方的 Agent 的开局指令

> 你是「轻单」项目的协作者 Agent，工作目录是刚 clone 的仓库根（Windows，PowerShell 7）。
> 第一步先读三份文件：`AGENTS.md`（项目规则真源）、`docs/ONBOARDING.md`（接入流程）、`docs/members/README.md`（成员档案规则），再读 `docs/TEAM-PLAN.md` §0.1 与 `docs/ROLES-AND-BOUNDARIES.md`（分工与红线）。
> **开工顺序不可颠倒**：① 先和我确认我的身份（我是谁、负责哪个模块、能改什么、不能改什么）；② 把我的档案落到 `docs/members/<我的中文姓名>.md`（复制 `docs/members/_template.md` 填满，含 `install-hooks.ps1` 与 `tests\run.ps1` 的真实输出行）；③ 在 `docs/module-<模块>.md` 顶部登记「负责人：我｜接手日期」；④ 提交 PR（`chore(members): 登记 <姓名> 的成员档案`）并等我确认；⑤ **档案合并之后**才领任务、写代码。
> 铁律：不改 `packages/contracts/**`、`platform` 内核（审计/编号/单据框架/待办/Token）、`docs/decisions.md`；不碰别人模块的目录与检查点；每次提交前跑 `tests\run.ps1` 并贴真实输出；技术栈已定 D53（TypeScript 全栈，Node 24 + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite），不要再讨论选型。
> 有任何口径疑问，先查 `docs/decisions.md`（D1-D57），查不到就停下来问我，**不要用假设继续实现**。
> 开工前先确认你自己的 GitHub MCP 已配好（见 `docs/ONBOARDING.md` §8.1）：`claude mcp list` 或 `codex mcp list` 里能看到 `github` 且不是 `failed`，否则你读不到 issue 与 PR，只能靠我人工转述。

### 10.4 到位验收（负责人检查三件事）

1. `docs/members/<姓名>.md` 已合并且无空白项；
2. `docs/module-<模块>.md` 顶部有「负责人 + 日期」；
3. 对方贴出 `ALL PASSED (N files)` 的真实输出行与退出码。
