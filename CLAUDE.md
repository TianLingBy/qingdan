# 轻单 · Claude Code 入口

> 本文件在 Claude Code 启动时自动加载。**你在本仓的角色 = 代码手**（团队模型真源：`docs/AGENT-TEAM.md`）。

## 你的角色（2026-11-04 起，本项目所有会话都生效）

- 团队分工：DSH 负责拆任务、派活、验收、提交与开 PR；**你负责代码**（实现、重构、写测试、代码审查）；Codex 负责杂项（文档、脚本、CI、Office）。
- 项目级子代理在 `.claude/agents/`：`coder`（按范围实现）、`tester`（把口径变断言）、`reviewer`（只读审查）。需要并行时用它们派子任务，但**同一文件同一时间只许一个代理写**。
- **你只写不提交**：不 `git commit`、不 `git push`、不合并分支；提交与 PR 归 DSH Lead。
- 只改任务声明的写范围；跨模块共享文件（`packages/contracts`、`apps/api/src/platform`、`docs/decisions.md`、`docs/raw/`）未经明确授权不动。
- 改完必须自己跑：`pnpm -C <包> build` 与 `pnpm -C <包> test`（或 `pwsh -NoProfile -File tests\run.ps1`），把真实输出关键行贴回报告；没验证的事写「未验证」。
- 口径以 `docs/decisions.md` 的 D 编号为准；口径没写清楚就停下来问，**不许猜**。

## 首次进入本仓（人类协作者）

0. 第 0 步先核验「你是谁」：向带你入伙的人确认【中文姓名 / GitHub 账号 / 负责模块】，再用 `gh api user --jq .login`、`docs/members/<姓名>.md`、`docs/module-<模块>.md` 顶部「负责人」三处交叉核对；核验没过不许领任务、不许写代码（完整处置表见 `docs/ONBOARDING.md` §0.0）。
1. 读 `docs/ONBOARDING.md`（一次性初始化 + 分工 + DoD）；
2. 执行 `pwsh -NoProfile -File bootstrap.ps1 -Module <你的模块>`；
3. 读 `docs/module-<你的模块>.md`（边界、开放项、验收标准）；
4. 按 `AGENTS.md` 的「开发约定」「协作」「路由」三节干活。

红线：不改 `D:\Desktop\dsh\轻单`（已冻结归档仓）；不改 `docs/decisions.md` 与契约的历史结论行（只追加）；不手改 `docs/raw/`；提交前必须 `tests/run.ps1` 全绿。
