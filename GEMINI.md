# 轻单 · Gemini CLI 入口

规则真源：`AGENTS.md`。协作者接入流程：`docs/ONBOARDING.md`。

首次进入本仓：

1. 读 `docs/ONBOARDING.md`；
2. `pwsh -NoProfile -File bootstrap.ps1 -Module <你的模块>`（macOS/Linux：`./bootstrap.sh <你的模块>`）；
3. 读 `docs/module-<你的模块>.md`，再开始开发。

红线：不改归档仓 `D:\Desktop\dsh\轻单`；`docs/decisions.md` 与契约只追加不改历史行；不手改 `docs/raw/`；提交前 `tests/run.ps1` 必须全绿。
