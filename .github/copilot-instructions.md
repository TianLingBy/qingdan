# 轻单 · Copilot 指令

规则真源：仓库根 `AGENTS.md`；协作者接入：`docs/ONBOARDING.md`。

- 首次进入：先读上述两份，再 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>` 完成初始化。
- 模块与分支对应见 `docs/ONBOARDING.md` §4；一个 PR 只改本模块写范围。
- 提交前 `tests/run.ps1` 必须通过；`docs/decisions.md` 与接口契约只追加不改历史行。
- 不要修改 `docs/raw/` 与已冻结的归档仓 `D:\Desktop\dsh\轻单`。
