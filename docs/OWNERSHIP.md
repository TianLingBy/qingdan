# 跨模块路径归属

**这张表是"改到这里会通知谁"的唯一依据；改表 = 改通知对象。**

| 路径 | 负责人（批准者） | 需要同时通知的人 | 说明 |
|---|---|---|---|
| `apps/api/src/platform/**`、`apps/api/migrations/**` | TianLingBy | 全体后端（Vince-Leong）、前端（karryL921、lozy66） | 内核与数据结构，动之前必须过负责人 |
| `packages/contracts/**` | TianLingBy | Vince-Leong、lozy66、karryL921、2696708617-web | 契约变更：所有客户端都要跟 |
| `packages/cli/**`、`packages/mcp/**` | TianLingBy | Vince-Leong | 客户端壳，跟契约联动 |
| `apps/api/src/modules/{masterdata,inventory,processing,internal-trade}/**` | Vince-Leong | TianLingBy | 后端业务用例 |
| `apps/web/**` | karryL921 | TianLingBy、lozy66 | 前端页面 |
| `docs/decisions.md`、`docs/轻单_接口契约*.md` | TianLingBy | 全体 | 口径真源，只追加 |
| `tests/**`、`tools/**`、`.github/**` | TianLingBy | — | 门禁与工具 |
| `docs/**`（其余） | TianLingBy | — | 文档 |

1. **同文件冲突**：动手前先在 Issues/PR 里搜这个文件是不是有人正在改；
2. **迁移文件**：只能新增 `0004+`，编号按顺序取，**不许改历史文件**（HANDOFF §5）；
3. **口径变动**：改 `decisions.md` 或契约的人负责在 PR 描述里写明「影响哪些模块」。
