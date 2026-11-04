# 轻单 · 智能体团队（三套 harness 分工）

> **状态**：2026-11-04 重建（负责人指令）。**唯一真源**：本文件 + `AGENTS.md`「路由」节 + `~/.dsh/AGENTS.md`「多智能体路由」节。
> **一句话**：DSH 是中间人（接指令、拆任务、备工具、验收、提交）；**代码活派 Claude Code**；**杂项派 Codex**；两者都可自建子团队。

## 1. 角色与 harness

| 角色 | harness | 模型/接入 | 干什么 | 不干什么 |
|---|---|---|---|---|
| **Lead（中间人）** | DSH（本会话） | `deepseek-flash` | 接负责人指令 → 拆任务 → 判断需要什么技能/MCP/联网工具并安装 → 派活 → 跑验收 → 统一提交/开 PR → 汇报 | 不自己闷头写业务代码（简单改动除外）；不自合并 `main` |
| **代码手** | **Claude Code CLI** 2.1.197 | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`deepseek-chat` | 写代码、改代码、重构、写测试、代码审查、跑命令自检 | 不改 `docs/decisions.md` 历史行；不自提交；超出写范围不动 |
| **杂项手** | **Codex CLI** 0.162.1 | `model_provider=deepseek`、`deepseek-flash`、`wire_api=responses` | 文档撰写/整理、资料调研（需联网时开 `web_search`）、脚本与配置、CI、批量改名、Office 文档、环境排错 | 不碰业务核心逻辑（那是 Claude Code）；不改口径文档 |

**调用方式（都是我这边发起）**：

```text
conductor_dispatch(agent: "claude-code", task: "<自包含任务>")   # 代码活
conductor_dispatch(agent: "codex",       task: "<自包含任务>")   # 杂项
```

两者都**看不到本会话上下文**，所以任务必须写成自包含：绝对路径 + 目标 + 写范围 + 验收命令 + 不许做什么。
单次派发硬超时 180 秒（`dsh-agent-conductor` 本机补丁值），跑不完就拆小再派。

## 2. 已验证事实（2026-11-04 实测）

- `claude --version` → `2.1.197 (Claude Code)`；`codex --version` → `codex-cli 0.162.1`。
- Claude Code 配置指向 DeepSeek：`~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_MODEL=deepseek-chat`（Opus/Sonnet/Haiku 四个别名全部映射 `deepseek-chat`）。
- Codex 配置指向 DeepSeek：`~/.codex/config.toml` 的 `model_provider=deepseek`、`model=deepseek-flash`、`wire_api=responses`、`base_url=https://api.deepseek.com/`。
- **两条腿都真跑通过**（`conductor_dispatch`，工作目录 `D:\Desktop\dsh\Qingdan`）：
  - Claude Code 答出工作目录 `/d/Desktop/dsh/Qingdan`（Git Bash 视角）与盘根；
  - Codex 正确数出仓库根 9 个顶层目录（`.cursor` `.git` `.github` `apps` `docs` `node_modules` `packages` `tests` `tools`）。
- **子团队能力**：
  - Claude Code：`--agents <json>` 可定义自定义代理、`claude agents` 管理后台代理会话、支持 `.claude/agents/*.md` 项目级代理（本仓已放 3 个，见 §5）。
  - Codex：`codex features list` 里 `multi_agent` = **stable / true**（已开启），另有 `agents`、`fork`、`queue` 等多会话命令；即**可以自己拉子代理干活**。

## 3. 派活规则（每次派发都照抄的模板）

```text
【任务】一句话目标
【工作目录】D:\Desktop\dsh\Qingdan
【写范围】只允许改：<文件/目录>；其他一律不动
【依据】读 docs/<相关文档>.md 的哪几节；口径以 docs/decisions.md 的 D<编号> 为准
【验收】<可执行命令> 必须退出码 0，并贴出关键输出行
【禁止】不改 docs/decisions.md 历史行 / 不 git commit / 不 push / 不装新依赖（需装先报）
【交付】改动的文件清单 + 命令与输出 + 未验证项
```

## 4. 技能 / MCP / 联网工具：要什么装什么

**评估与安装是 Lead 的职责**，每次派活前判断，缺就装，装完记到下面的表里（不预先铺一堆）。

| harness | 现在有什么 | 缺什么/怎么补 | 安装位置 |
|---|---|---|---|
| Claude Code | 本地读写、Bash、Git、MCP 客户端、子代理、skills、后台代理 | 需要浏览器/外部系统时加 MCP：`claude mcp add <name> ...` 或项目 `.mcp.json` | `~/.claude.json` 或项目 `.mcp.json` |
| Codex | 本地读写、`apply_patch`、插件（documents/spreadsheets/presentations/pdf/browser/computer-use 已启用）、MCP（`codex mcp`）、多智能体（`multi_agent` = stable/true） | **联网搜索当前被关**（`web_search = "disabled"`）：`conductor_dispatch` 只传任务文本、透传不了自定义旗标，所以① 常规做法 = Lead 先查好事实再派活；② 确实要它自己搜，就绕开 conductor 直调 `codex exec -c web_search="live" ...` | `~/.codex/config.toml` / `codex mcp add` |
| DSH（我） | skills（ponytail / office / systematic-debugging 等）、REA 逆向、web 搜索/抓取、自动化任务 | 按任务加载，不常驻 | `~/.dsh/skills`、`~/.dsh/cordis.patch.yml` |

**铁律**：装之前先说清"为什么需要、装哪、怎么卸"，装完登记（仓库外改动登记到 `docs/roadmap.md`「外部依赖」表）。

## 5. 三方的子团队

| harness | 怎么建 | 本仓现状 |
|---|---|---|
| Claude Code | `.claude/agents/<名字>.md`（frontmatter: `name` / `description` / `tools` / `model`） | 已放 `coder` / `tester` / `reviewer` 三个代理定义 |
| Codex | `multi_agent` 已开启：让它自己拆子任务并派子代理；Lead 侧仍可 `fork` 会话 | 无需额外文件；在任务里写「允许你自己开子代理」 |
| DSH | `spawn_teammate`（Agent Teams） | 本轮不再用 DSH 队友扛实现；只在需要并行探索/交叉审查时临时用 |

**注意**：子代理越多越吃额度、越容易互相踩文件。规则：**同一时间同一文件只许一个代理写**；子代理只写不提交。

## 6. 边界（三套 harness 都适用）

- 不改 `docs/decisions.md` 与契约的历史结论行（只追加）。
- 不在仓库放密钥；凭证只走环境变量/用户级配置。
- 不擅自 `git commit` / `push` / 自合并 `main`——提交与 PR 归 Lead。
- 改动超出写范围、或需要安装新依赖/新 MCP → 先停下来报告，不许自己扩权。
- 未验证的事一律标注「未验证」，不许用「应该/通常」代替跑一遍。

## 7. 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-04 | 建立三套 harness 分工（DSH 中间人 / Claude Code 代码 / Codex 杂项）；实测两条腿都通、都接 DeepSeek；落 3 个 Claude Code 子代理定义；明确技能/MCP「按需装」流程 | 负责人指令：重新搭建智能体团队 |
