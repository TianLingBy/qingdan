# 轻单 · Claude Code 入口

本仓的规则真源是 `AGENTS.md`，协作者接入流程在 `docs/ONBOARDING.md`。第一次进入本仓请按这个顺序：

1. 读 `docs/ONBOARDING.md`（一次性初始化 + 分工 + DoD）；
2. 执行 `pwsh -NoProfile -File bootstrap.ps1 -Module <你的模块>`；
3. 读 `docs/module-<你的模块>.md`（边界、开放项、验收标准）；
4. 按 `AGENTS.md` 的「开发约定」与「协作」两节干活。

红线：不改 `D:\Desktop\dsh\轻单`（已冻结归档仓）；不改 `docs/decisions.md` 与契约的历史结论行（只追加）；不手改 `docs/raw/`；提交前必须 `tests/run.ps1` 全绿。
