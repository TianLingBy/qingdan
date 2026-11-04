# 轻单 · Copilot 指令

规则真源：仓库根 `AGENTS.md`；协作者接入：`docs/ONBOARDING.md`。

- 第 0 步先核验「你是谁」：向带你入伙的人确认【中文姓名 / GitHub 账号 / 负责模块】，再用 `gh api user --jq .login`、`docs/members/<姓名>.md`、`docs/module-<模块>.md` 顶部「负责人」三处交叉核对；核验没过不许领任务、不许写代码（完整处置表见 `docs/ONBOARDING.md` §0.0）。
- 首次进入：先读上述两份，再 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>` 完成初始化。
- 模块与分支对应见 `docs/ONBOARDING.md` §4；一个 PR 只改本模块写范围。
- 提交前 `tests/run.ps1` 必须通过；`docs/decisions.md` 与接口契约只追加不改历史行。
- 不要修改 `docs/raw/` 与已冻结的归档仓 `D:\Desktop\dsh\轻单`。
