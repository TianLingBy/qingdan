# 成员档案：<姓名>

> 复制本文件为 `docs/members/<姓名>.md` 后逐项填写；「负责人」一栏由负责人确认，其他人不要代填。

| 项 | 内容 |
| --- | --- |
| 姓名 | |
| 角色 | |
| 所属板块 | 账号 / 客户 / 订单 / 仓库 / 人员 / 前端 UI / 架构与集成 |
| 加入日期 | |
| GitHub 账号 | （填了才能被 @ 与 assign） |
| 直系对接人 | |

## 负责范围

- 负责的模块 / 页面 / 端点（写清 issue 编号）：
- 明确**不**负责的（避免越界）：

## 工作流程（所有人一致，2026-11-05 起）

1. 任务只在 GitHub issue 领：`https://github.com/TianLingBy/qingdan/issues`；本地笔记不算进度。
2. 分支命名：`feat/<模块>-<要点>` / `fix/<模块>-<要点>` / `docs/<要点>`。
3. PR 描述必须写 `- Blocked by: 无` 与 `- Blocks: 无`（没有阻塞也写「无」，CI 的 fields 检查会拦）。
4. 合并前必须：`pnpm -r build`、`pnpm -r test`、`pwsh -NoProfile -File tests\run.ps1` 全绿，CI 七项全绿。
5. 只改自己模块；要动别人模块先在 issue 里 @ 对方拿同意（公告 #119）。

## 上手步骤

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
pwsh -NoProfile -File install-hooks.ps1   # 装提交前护栏并当场跑一遍全量测试
corepack enable
pnpm install
pnpm -r build
pnpm -r test
```

先读：`README.md` → `packages/contracts/src/index.ts`（接口真源）→ 自己负责的模块目录 → `docs/api/openapi.yaml`。

## 验收标准（每个页面/端点都要满足）

- 接真实接口，不用假数据；空态、加载态、错误态都要有。
- 金额字段走「看价」权限：没权限时展示占位，不给 0、不报错。
- 有对应的自动化测试；UI 附截图。
- 不新增依赖前先说明理由；不引入与现有设计不一致的视觉。
