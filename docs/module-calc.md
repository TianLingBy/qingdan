# 模块：calc（四则运算）

## 目标

提供基础四则运算；同时作为第一个真实业务模块，验证「业务测试能接进测试底座」。验收标准 = `tests\run.ps1` 里契约测试与 `calc.test.ps1` 同时绿。

## 当前状态

进行中（`add` 已实现并受测；其余运算符未做，等真实需求）

## 已完成

- `calc.js`：`add(a, b)`，入参非数字时抛 `TypeError`（否则 `'1' + 2` 会静默变 `'12'`）。
- `tests/calc.test.ps1`：4 项真实断言 —— `add(1,2)=3`、`add(-1,1)=0`、`add(0.5,0.25)=0.75`、字符串入参抛错。
- 模块已登记到 `AGENTS.md`，检查点由 `docs-checkpoint.test.ps1` 校验。

## 进行中

- 无。等真实需求决定要不要 `sub` / `mul` / `div`。

## 下一步

- 需要减法/乘法时再补实现 + 对应断言，不改 `run.ps1`。

## 已知问题 / 坑

- 测试用 PATH 上的 node（当前 v18.20.8），不需要切 nvm；若以后用 ES module 语法要同步改加载方式。
- `require('./calc.js')` 按 cwd 解析，测试里必须 `Push-Location $root`，否则从别处跑会 `MODULE_NOT_FOUND`。
- 浮点没有精度处理（`add(0.1,0.2)` 不等于 `0.3`）；真要处理得引十进制库，现在不做。
- `tests/calc.test.ps1` 用内联 `node -e` 桥接 JS，断言一多字符串会难读；到那时抽 `tests/calc.node.js` 或换 JS 测试框架——现在 5 条断言，不值得为此引一整个 npm 依赖树。

## 相关文件

- `calc.js`
- `tests/calc.test.ps1`
- `AGENTS.md`
