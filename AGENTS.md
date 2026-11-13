# 轻单项目记忆（项目根 AGENTS.md）

本文件只对 `D:\Desktop\dsh\Qingdan`（`github.com/TianLingBy/qingdan`）生效。**DSH 全局记忆在 `C:\Users\32800\.dsh\AGENTS.md`**，两边不重复：全局记「每次会话都要遵守的行为约定 + 本机环境结论」，这里记「这个项目的派活与进度口径」。

## 有疑惑就直接问用户，不许猜（2026-11-13 用户新增规则）

- 任何**疑惑、不确定、有多种可能性**的地方——需求边界、验收口径、优先级、某个数字/字段从哪来、要不要动某个文件、选哪种实现、这活算谁的——**一律当场直接向用户提问**，不许挑一个"看起来最合理"的默认值往下做，也不许先做一版让用户回头改。
- 问法：一个决策点一个问题，附上**我倾向的候选答案 + 选它会影响什么**，让用户一句话就能拍板；多个决策点可一次列全，不要挤牙膏式来回问。
- 唯一的例外：**客观事实类**（能靠命令、代码、文档、issue 查清的）先去查，查不到、查到互相冲突、或查到结果与用户说法不一致时，再带着「我查到了什么」去问。事实不用问，判断必须问。
- 与上面「不派发的：需求澄清、口径裁定」一致：澄清是 DSH 自己的活，不外派给 Claude Code / Codex 去替用户猜。

## 多智能体路由

**团队模型**：DSH = 中间人/负责人；**代码活 → Claude Code**；**杂项 → Codex**；两者都接 DeepSeek，且都能自建子团队。

- **DSH（我）职责**：接指令 → 拆任务 → **判断并安装所需技能/MCP/联网工具**（要什么装什么，装完登记）→ 派活 → 跑验收 → 统一提交/开 PR → 汇报。不闷头写业务代码（小改动除外）。
- **代码活 → `conductor_dispatch(agent:"claude-code")`**：Claude Code CLI 2.1.197，`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`deepseek-chat`；实现/重构/测试/代码审查。项目子代理在 `.claude/agents/*.md`。
- **杂项 → `conductor_dispatch(agent:"codex")`**：Codex CLI **0.154.0**（`D:\WorkBuddyData\npm-global\codex.exe`；桌面 App 自带的是 0.166.0-alpha.6，别混），派活时插件注入 `CODEX_HOME=C:\Users\32800\.codex-deepseek` 走 DeepSeek（`model_provider=deepseek`、`deepseek-flash`）；文档整理、资料整理、脚本配置、CI、批量改名、Office、排错。`multi_agent` 已开启。
- **不派发的**：探索性讨论、需求澄清、口径裁定、给用户看的解释——自己回答。
- **联网**：默认用 DSH 自带 `web_search`/`web_fetch`；Codex 的 `web_search` 当前 `disabled`，要给 Codex 联网就直调 CLI 加 `-c web_search="live"`（conductor 透传不了自定义旗标）。
- **派发硬规则**：任务自包含（绝对路径 + 写范围 + 依据 + 验收命令）；单次硬超时 180s，大活拆小；外部代理只写不提交；验收只看命令退出码与输出关键行。
- 派发前不确定范围先 `dryRun: true`。

## 团队任务与进度：GitHub 唯一来源

- **GitHub 是团队唯一的任务与进度来源**：所有成员一律在 GitHub 上连接团队仓库（工程仓 `https://github.com/TianLingBy/qingdan`，私有），并通过 GitHub issue 领取工作任务、汇报进度；任务与进度只认 issue / PR 状态。
- 分工不变：DSH 仍负责具体干活（代码、文档、通知、验收），但「谁做什么、做到哪了」一律以 GitHub 为准。**不要把任务状态快照写进本文件**——过期快照只会误导。
- 派活纪律：代码活 → `conductor_dispatch(agent:"claude-code")`（拆到 180s 内），杂项/文档 → Codex，DSH 只做拆解、验收、提交与汇报；不替队友写他们模块的业务代码（2026-11-07 越界代做教训）。

## 项目内真源文档

- 团队计划与分工：`docs/TEAM-PLAN.md`
- 部署与验收：`docs/deploy.md`、`docs/DEV-SETUP.md`、`docs/acceptance-2026-11-12.md`、`docs/local-acceptance-2026-11-12.md`
- 架构决策（ADR）：`docs/adr-0001-tech-stack.md`、`docs/adr-0002-settlement-settled-at.md`、`docs/adr-0003-purchase-products-company-d15.md`
- 模块清单与模板：`docs/module-inventory.md`、`docs/module-template.md`、`docs/module-report.md`
