# 路径归属（OWNERSHIP）

> 本文件是**「改动落在哪个目录，谁说了算」的唯一真源**。
> `docs/TEAM-PLAN.md` 管人和板块；本文件管路径。两者冲突时，人/板块以 TEAM-PLAN 为准，路径路由以本文件为准。
> 机器执行版是 `.github/workflows/route-review.yml`——**两者必须一致**，改一个必须同时改另一个。
> 最近更新：2026-11-15

## 一、路由表

| 路径前缀 | 负责人（owner） | 会通知 | 标签 | 严重度 |
|---|---|---|---|---|
| `apps/api/src/platform/` | TianLingBy | Vince-Leong, karryL921, lozy66 | `scope:platform` | **critical** |
| `apps/api/migrations/` | TianLingBy | Vince-Leong, karryL921, lozy66 | `scope:migrations` | **critical** |
| `packages/contracts/` | TianLingBy | Vince-Leong, lozy66, karryL921, 2696708617-web | `scope:contracts` | **critical** |
| `packages/cli/` | TianLingBy | Vince-Leong | `scope:cli` | 普通 |
| `packages/mcp/` | TianLingBy | Vince-Leong | `scope:mcp` | 普通 |
| `docs/decisions.md` | TianLingBy | 全员 | `scope:decisions` | **critical（只允许追加）** |
| `docs/轻单_接口契约*` | TianLingBy | 全员 | `scope:contracts` | **critical** |
| `apps/api/src/modules/masterdata/`、`inventory/`、`processing/`、`internal-trade/` | Vince-Leong | TianLingBy | `scope:backend` | 普通 |
| `apps/web/` | karryL921 | TianLingBy, lozy66 | `scope:web` | 普通 |
| `tests/` | TianLingBy | — | `scope:tests` | 普通 |
| `tools/` | TianLingBy | — | `scope:tools` | 普通 |
| `.github/` | TianLingBy | — | `scope:ci` | 普通 |
| `docs/`（其余） | TianLingBy | — | `scope:docs` | 普通 |

匹配规则：按前缀匹配，**越具体的规则排在越前面**；一个文件命中第一条即停止。

## 二、红线（不是「先做后审」，是「先审后做」）

以下路径**只有 TianLingBy 能直接改**，其他人（含任何 AI 执行器）必须先拿到负责人在 issue 或 PR 里的明确同意，再动：

- `packages/contracts/` —— 契约变更影响全部客户端
- `apps/api/src/platform/` —— 审计 / 编号 / 单据框架 / 待办 / API Token
- `apps/api/migrations/` —— 数据库迁移会改变共享数据结构
- `docs/decisions.md` —— 口径真源，**只允许追加**，不允许改写既有结论
- `docs/轻单_接口契约*`
- `.github/` —— CI 与协作流程

打上 `需批准` 标签的 PR，必须由 TianLingBy 点过 approve 才能合并。

## 三、单点负责（防撞车）

同一个文件同一时间只有一个人改。

- `apps/web/src/pages/**` —— 按页面归属，见 `docs/TEAM-PLAN.md` 第二节
- `apps/web/src/components/**` —— 归 Meow-Yay（何永上）；业务实现者提需求，不直接改组件，也不复制一份新的
- 开工前先看 open PR 是否已经碰同一目录；碰了就先在 issue 里对齐，别并行改

## 四、改这张表的流程

1. 在 issue 里写清「哪个路径 → 谁的活」，@TianLingBy
2. 同一次 PR 里改 `docs/OWNERSHIP.md` **和** `.github/workflows/route-review.yml`
3. 两个文件不一致时，以本文件为准修 workflow，不允许反过来

## 五、维护者

| 职责 | 人 |
|---|---|
| 本文件与 route-review.yml 同步维护 | TianLingBy |
| 各自板块路径的归属解释 | 对应 owner |
