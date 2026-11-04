# 成员档案模板

> 用法：复制本文件为 `docs/members/<你的中文姓名>.md`，逐项填满后提交 PR。
> **任何一项留空或写「待定」，视为档案未完成，不得开工。**

## 身份

| 项 | 内容 |
|---|---|
| 姓名 | `<中文真实姓名>` |
| 角色 | `<例如：人类开发者 / 前端工程师 / 后端工程师>` |
| 交付模块 | `<参见 docs/TEAM-PLAN.md §0.1>` |
| 负责的代码模块 | `<例如：masterdata、inventory>` |
| 分支名 | `<例如：feat/m2-inventory>` |
| 负责人 / 评审人 | `<谁评审你的 PR>` |
| GitHub 账号 | `<your-github-login>` |
| 接手日期 | `<YYYY-MM-DD>` |

## 写范围

- **我可以改**：`<目录/文件前缀清单，例如 apps/api/src/masterdata/**、docs/module-masterdata.md>`
- **我不能改**（红线，违反即打回）：
  - `packages/contracts/**`（只有主线能改；需要新字段先提 PR 给主线）
  - `platform` 内核：审计写入、编号、单据框架、待办、API Token
  - `docs/decisions.md`（只追加，且由主线统一追加）
  - 他人模块的目录与检查点文件
  - `<本项目/本模块特有的其他红线，自己补>`

## 环境自检（贴真实输出，不要只写「通过」）

```text
$ pwsh -NoProfile -File install-hooks.ps1
<hook 安装完成 + 测试 PASSED 的真实输出行>

$ pwsh -NoProfile -File tests\run.ps1
ALL PASSED (N files)   ← 贴实际行与退出码
```

## 我的第一个任务（开工后填）

- 任务来源：`<GitHub Issue #编号 / 里程碑>` 
- 目标：`<一句话>`
- 完成标志：`<验收标准，指向 docs/module-<模块>.md 的哪几条>`

## 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| `<YYYY-MM-DD>` | 建档 | 首次接手 |
