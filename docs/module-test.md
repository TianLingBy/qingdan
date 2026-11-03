# 模块：test（测试）

## 目标

给项目一个可一键运行、可平滑扩展的测试入口；验收标准 = `pwsh -NoProfile -File tests\run.ps1` 退出码 0，且新增模块只要补“检查点”就能被自动校验。

## 当前状态

进行中（骨架与契约测试已可运行；项目尚无业务代码，暂无可测行为）

## 已完成

- `tests/run.ps1`：按文件名逐个执行 `tests\*.test.ps1`（子进程隔离，支持 `-Filter` 过滤），任一失败即退出码 1。
- `tests/assert.ps1`：`Assert-True` / `Assert-Equal` / `Exit-Test`，失败计数走 `$global:`，退出码由 `Exit-Test` 决定。
- `tests/docs-checkpoint.test.ps1`：检查点契约 —— 模板小节齐全、`AGENTS.md` 登记的模块都有检查点、每个检查点小节齐全且「当前状态」已填。
- 实跑通过：`tests\run.ps1` → `ALL PASSED (1 files)` / `OK 19 checks` / 退出码 0。
- 负向验证通过：临时副本删掉 `docs/module-test.md` 后 → `FAIL 模块 test 的检查点存在` / 退出码 1，说明测试真会红。

## 进行中

- 等第一批业务代码落地后，把契约测试扩到“模块声明的相关文件必须存在”。

## 下一步

- 业务模块开始时按 `<模块>.test.ps1` 命名接入，不改 `run.ps1`。
- 需要时再加 CI 或 git hook 调用 `tests\run.ps1`。

## 已知问题 / 坑

- 测试只覆盖文档/检查点契约，**没有**被测业务代码，因此“测试通过”目前不代表任何业务行为正确。业务模块落地时必须补充真实用例；`run.ps1` 直接识别 `*.test.ps1`，无需改框架。
- 测试脚本是 `.ps1` 且依赖 pwsh 7；用 5.1 跑必须带 UTF-8 BOM（本目录已加），否则中文被按 GBK 解码会报 `The string is missing the terminator`。
- `run.ps1` 用 `$LASTEXITCODE` 判定子测试结果，只对 `pwsh -File` 子进程有效；不要在测试文件里 `exit 0` 提前返回。

## 相关文件

- `AGENTS.md` —— 模块登记、测试约定
- `docs/module-template.md` —— 检查点模板
- `tests/run.ps1`、`tests/assert.ps1`、`tests/docs-checkpoint.test.ps1`
