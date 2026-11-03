# 模块：test（测试底座）

> 所属交付模块：**MAIN 主线**（Lead 维护，不单独开分支）

## 目标

给项目一个可一键运行、可平滑扩展的测试入口：新增模块只补「检查点 + 自己的业务测试」，不改测试框架。验收标准 = `pwsh -NoProfile -File tests\run.ps1` 退出码 0。

## 范围与页面

- **范围**：`tests\run.ps1`（执行器）、`tests\assert.ps1`（断言）、`tests\docs-checkpoint.test.ps1`（检查点契约）、`tests\requirements.test.ps1`（交接完整性契约）、`tools\pre-commit` + `install-hooks.ps1`（提交前护栏）。
- **不含**：业务正确性断言（由各业务模块自己的 `*.test.ps1` 负责）。

## 依赖

- 上游：无（P0 基础设施）。
- 下游：全部模块——新增 `tests\<模块>.test.ps1` 即被 `run.ps1` 自动纳入，不需要改框架。

## 开放项

- 无。
- 非阻塞待定：CI 等有远端仓库再做；当前只有本地 hook 兜底。

## 验收标准

- `pwsh -NoProfile -File tests\run.ps1` 退出码 0，输出 `ALL PASSED`。
- 新增 `tests\<模块>.test.ps1` 无需改 `run.ps1`。
- 删掉任一已登记模块的检查点 → `docs-checkpoint` 变红（已做负向验证）。
- `AGENTS.md` 的模块登记与 `docs/module-*.md` 一一对应。
- 新 clone 跑 `install-hooks.ps1` 能装回 hook，且当场测试通过、源与已装版本哈希一致。

## 当前状态

进行中（接入与协作文档测试落地后全量 4 个测试文件 / 351 项断言全绿；hook 已按新源重装并哈希一致）

## 已完成

- `tests/run.ps1`：按文件名逐个执行 `tests\*.test.ps1`（子进程隔离、支持 `-Filter`），任一失败即退出码 1。
- `tests/assert.ps1`：`Assert-True` / `Assert-Equal` / `Exit-Test`，失败计数走 `$global:`，退出码由 `Exit-Test` 决定。
- `tests/docs-checkpoint.test.ps1`：模板 7 小节齐全、`AGENTS.md` 登记的模块都有检查点、检查点小节齐全且「当前状态」已填 —— 91 项。
- `tests/requirements.test.ps1`：迁移完整性（10 份产品文档（含第三批草案）、两批契约冻结标记 + 第三批草案标记、raw 11 篇 + frontmatter、prototype.html、9 模块与 docs/README 映射、calc 脚手架已清、roadmap 阶段 4、hook 可复刻）—— 99 项。
- `tests/onboarding.test.ps1`：协作者接入契约（`bootstrap.ps1`/`bootstrap.sh` 存在且真调 hook、ONBOARDING 七节齐全且覆盖 9 模块、4 个 Agent 指针都指向真源、AGENTS/README/docs 索引一致、PR 模板含检查项）—— 46 项。
- `tests/team-docs.test.ps1`：协作分工契约（TEAM-PLAN 五条开发线与写范围、ROLES-AND-BOUNDARIES 能做/不能做/红线/灰区审批/文件级矩阵、DEV-SETUP 环境与目录、ADR 五节齐全、三份文档互相索引）—— 115 项。
- 实跑（2026-11-04）：`tests\run.ps1` → `OK 91 checks` / `OK 46 checks` / `OK 99 checks` / `OK 115 checks` / `ALL PASSED (4 files)` / exit 0。
- 负向验证（迁移前）：临时删掉模块检查点后 `FAIL 模块 test 的检查点存在`、退出码 1，说明测试真会红。
- 提交前护栏：`tools/pre-commit` 已入库；`install-hooks.ps1` 一键安装（取 `git rev-parse --git-path hooks`、强制 LF、哈希自检、装完跑全量测试）；`.gitattributes` 钉死 LF。迁移后重装：源与已装 SHA-256 一致（`4222BE04…`）。

## 进行中

- 无。

## 下一步

- 各业务模块开工时按 `<模块>.test.ps1` 接入，不改 `run.ps1`。
- 有远端仓库后再加 CI。

## 已知问题 / 坑

- 契约测试只保证「检查点存在且填写规范」，**不保证业务正确**；业务正确性靠各模块自己的 `*.test.ps1`。
- `.ps1` 写完必须补 BOM（`write`/`edit` 工具会丢），否则 5.1 下中文被按 GBK 解码报 `The string is missing the terminator`；pwsh 7 不受影响。
- `run.ps1` 用 `$LASTEXITCODE` 判定子测试结果，只对 `pwsh -File` 子进程有效；不要在测试文件里 `exit 0` 提前返回。
- hook 依赖 PATH 上能找到 `pwsh`：找不到时**报错阻止提交**而不是静默放行。
- 提交被 hook 阻止后的恢复顺序：`git reset` → `git checkout HEAD -- <file>` → 复跑 `tests\run.ps1`；只做 `git checkout --` 会从**暂存区**恢复坏版本。
- `.git/hooks` 不进版本控制：clone 或重装仓库后必须跑 `install-hooks.ps1`，否则 hook 静默消失。
- `requirements.test.ps1` 与文档强耦合（模块数、raw 篇数）：改模块切分或补原料时同步改断言，否则红的是测试不是代码。

## 相关文件

- `AGENTS.md`（模块登记、测试约定）
- `docs/module-template.md`（检查点模板）
- `tests/run.ps1`、`tests/assert.ps1`、`tests/docs-checkpoint.test.ps1`、`tests/requirements.test.ps1`
- `tools/pre-commit`、`install-hooks.ps1`、`.gitattributes`
