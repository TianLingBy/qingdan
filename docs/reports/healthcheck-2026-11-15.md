# 仓库一致性体检报告（文档 / 代码 / 测试 三方对照）

> 日期：2026-11-15
> 基线：`main` @ `3c424a6`（docs(agents): 新增「有疑惑直接问用户」规则）
> 性质：只读体检，只新增本文件。所有结论都可落到 `文件:行号`。
> 环境：Ubuntu + Node 24 + pwsh 7（实测 Node v24.22.3 / pnpm 11.28.10 / pwsh 7.5.4）。

体检覆盖 issue #231 正文要求的五件事，另附「建议派工表」。

> **后续状态（2026-11-21 补记，原文一律不改）**
>
> 本文是 11-15 的快照。其中有几条「不存在 / 没人接」的结论**已经被后续提交反转**，照原文读会让人以为还得从头做一遍。逐条如下：
>
> - **§5 第 58–60 行（`workbench-mock.ts` 的两条 TODO）**：该文件已在 PR #384（`f9dba31`）被删除，工作台改吃 `GET /api/v1/todos`。原文说的 `GET /api/v1/todos`「契约里根本没有」、`GET /api/v1/inventory/alerts`「契约里没有 alerts 路由」两条**均已落地** —— 前者见 D89 与 `packages/contracts/src/todos.ts`，后者见 D104 与 `packages/contracts/src/inventory.ts:236`。
> - **§5 第 60 行（`GET /api/v1/companies`）**：原文判断正确（`platform.company.list` 已挂载），无变化。
> - **「建议派工表」里标为待做的低库存预警与工作台待办**：分别由 D104（`b3c9a7a`）与 D89 完成；待办后来又加第 7 类「低库存批次」（#378，`6ce942f2`）。
>
> 为什么保留原文：这是「当时的证据」，删掉就失去「某天仓库真实长什么样」的记录。补记放这里，读的人先看到「哪几条已经过期」。

---

## 一、文档 vs 现实

逐条对照 `README.md`、`docs/DEV-SETUP.md`、`docs/deploy.md`、`docs/TEAM-PLAN.md`、`docs/module-inventory.md` 与仓库实际脚本/配置。命中「对不上」的如下，按影响排序：

1. **DEV-SETUP 的 403 机理解释与代码相反（changeOrigin）**
   - `docs/DEV-SETUP.md:57`：写「`apps/web/vite.config.ts` 的代理开了 `changeOrigin: true`，API 收到的 `Host` 已被改写成 `127.0.0.1:3000`」。
   - `apps/web/vite.config.ts:49`：实际是 `changeOrigin: false`，注释明确「保留浏览器 Host」。
   - 差异：文档说 true，代码是 false。§4「不设 `PUBLIC_BASE_URL` → 按 Host 期望 127.0.0.1:3000 ≠ 浏览器 localhost:5173 → 403」这条推导已过时；当前行为是保留浏览器 Host（localhost:5173），结论口径需要随代码更新。

2. **`docs/OWNERSHIP.md` 不存在，但被 workflow 与本单引用**
   - `.github/workflows/route-review.yml:29`：注释「与 `docs/OWNERSHIP.md` 保持一致」。
   - 全仓无 `docs/OWNERSHIP.md`（`find` 仅命中 screenshots 里的 `*-owner-*` 图片）。归属真源实际拆在 route-review.yml 内嵌规则与 `docs/TEAM-PLAN.md` 两份，没有那份被反复引用的路由表。

3. **`docs/decisions.md` 不存在，但被代码/文档反复当作 D 编号口径真源**
   - `docs/TEAM-PLAN.md:21`：红线「`docs/decisions.md` 只有主线能改」。
   - `apps/web/vite.config.ts:6`：注释「浏览器基线见 `docs/decisions.md` D56」。
   - `docs/adr-0001-tech-stack.md:346`：「结论落 `docs/decisions.md` D55」。
   - `.github/workflows/route-review.yml:89`：前缀规则 `docs/decisions.md`。
   - 代码注释大量引用 D54/D56/D59/D62/D70/D71 等编号（如 `apps/api/src/modules/platform/routes.ts:51`、`apps/api/src/platform/http/route-mount.ts:7`），但这些 D 编号的真源文件不在仓库里。

4. **TEAM-PLAN 引用两个不存在的路径**
   - `docs/TEAM-PLAN.md:32`：何永上交付「`apps/web/src/components/` 公共组件库」——`apps/web/src/` 下没有 `components/` 目录。
   - `docs/TEAM-PLAN.md:33`：赖皓妍交付「`prototype-v0.md` + D56」——仓库只有根目录 `prototype.html`，无 `prototype-v0.md`。

5. **README 模块表缺 `payment` / `report` 两个真实模块**
   - `README.md:77-86`：模块表只列了 8 个模块（platform/masterdata/inventory/purchase/processing/sales/internal-trade/settlement）。
   - 实际 `apps/api/src/modules/` 有 10 个业务模块，多了 `payment`、`report`；`packages/contracts/src/modules.ts:9-10` 也登记了 `payment`（支付回调/对账）与 `report`（利润报表/跨模块聚合）。

6. **deploy.md 上线检查清单的迁移编号停在 0026/0027，与现状 0030 不一致**
   - `docs/deploy.md:93`：「本次发布含 0026（结算确认时间）与 0027（采购单 D15 触发器）」。
   - `docs/deploy.md:136` 同文件验证记录自述「现到 0030」；`apps/api/migrations/` 实际已到 `0030_login_code.sql`。上线清单里只提到 0026/0027，没覆盖 0028/0029/0030。

7. **（低）README 未给 Linux/macOS 指路已存在的 `bootstrap.sh`**
   - `README.md:26`：「macOS / Linux 把 `install-hooks.ps1` 换成对应步骤即可」。
   - 实际 `install-hooks.ps1:36-39` 已自行处理 POSIX 的 `chmod`，跨平台可跑；仓库另有 `bootstrap.sh:2` 标注「一键初始化（macOS / Linux）」作为正式入口，README 既没指路，说法也偏误导。

---

## 二、TODO 清单

全仓 `TODO` / `FIXME` / `占位数据` / `接口待做` 按模块归类，标注每处处境（有人接 / 没人接 / 已在别处实现）。

### 2.1 Web 前端「接口待做 / 占位数据」

| 位置 | 内容 | 处境 |
| --- | --- | --- |
| `apps/web/src/pages/workbench/workbench-mock.ts:9` | `TODO(接口待做): GET /api/v1/todos` 待办列表 | 没人接——契约里根本没有 todos 路由 |
| `apps/web/src/pages/workbench/workbench-mock.ts:11` | `TODO(接口待做): GET /api/v1/inventory/alerts` 库存预警 | 没人接——契约里没有 alerts 路由 |
| `apps/web/src/pages/workbench/workbench-mock.ts:12` | `TODO(接口待做): GET /api/v1/companies` 公司切换下拉 | 已在别处实现——`apps/api/src/modules/platform/routes.ts:174` 的 `platform.company.list` 已挂载 |
| `apps/web/src/pages/workbench/workbench-mock.ts:10` | `TODO(接口待做): GET /api/v1/sales-orders?handlerId=me` | 端点存在，前端按 handlerId 过滤的接线未做 |
| `apps/web/src/layouts/AppLayout.tsx:122` | 「公司切换待接口：`GET /api/v1/companies` + 会话内切换」 | 已在别处实现（同上） |
| `apps/web/src/pages/employees/PermissionOverridePanel.tsx:18`、`:252` | 「TODO(接口待做): 覆盖明细读端点」 | 没人接——覆盖读端点未上线 |
| `apps/web/src/pages/flow/FlowPage.tsx:141` | 「页面待做」标签 | 页面本身待做 |

工作台页面对应「占位数据」标注：`apps/web/src/pages/workbench/WorkbenchPage.tsx:165`、`:218`。

### 2.2 契约注释「D54 缺口 10」已过时

- `packages/contracts/src/routes.ts:35` 与 `apps/api/src/modules/platform/routes.ts:51` 仍写「先登记签名，handler 后补」。
- 实测：契约登记的 104 个 operationId 全部在 `handlers` 里有对应实现（`registered - handlers` 差集为空）——缺口已补完，这两处注释应更新为现状。

### 2.3 文档级待办

- `docs/adr-0001-tech-stack.md:346`：「U12 spike 仍待做（platform 写第一行业务代码前）……U6-U11 未拍板」。

### 2.4 排除项说明

各模块 `routes.ts` / `usecases` 里大量「数据库未配置 → 501 `NOT_IMPLEMENTED`」（如 `apps/api/src/modules/inventory/routes.ts:27-32`）是「无数据库时骨架语义」的设计兜底，handler 均已实现，**不属于**「接口待做」，不列入缺口。

---

## 三、测试缺口

规则：`apps/api/src/modules/**` 按模块、`apps/web/src/pages/**` 按页面目录，看有没有对应测试文件。

### 3.1 API 模块（10/10 全部有测试）

| 模块 | 测试文件数 |
| --- | --- |
| platform | 10 |
| masterdata | 8 |
| sales | 8 |
| purchase | 6 |
| settlement | 6 |
| inventory | 4 |
| payment | 3 |
| processing | 3 |
| internal-trade | 2 |
| report | 2 |

结论：API 侧无模块级缺口。

### 3.2 Web 页面（16 个目录，4 个无页面级测试）

| 页面目录 | 测试文件数 | 说明 |
| --- | --- | --- |
| api-integration | 0 | `ApiIntegrationPage.tsx` 无测试 |
| audit | 0 | `AuditLogsPage.tsx` 无测试 |
| permissions | 0 | `PermissionsPage.tsx` 无测试 |
| employees | 1 | 仅 `domain-words.test.ts`（测工具函数）；`EmployeesPage.tsx`、`PermissionOverridePanel.tsx` 无页面测试 |

其余 12 个目录（auth/companies/flow/internal-trades/inventory/masterdata/processing/purchase/reversals/sales/settlements/workbench）均有页面级测试文件。

---

## 四、归属漂移

要求：`.github/workflows/route-review.yml` 的路径规则与 `docs/OWNERSHIP.md` 路由表逐条比对。**但 `docs/OWNERSHIP.md` 不存在**，无法做逐条比对；以下是可验证的漂移：

1. **比对基准缺失**：`docs/OWNERSHIP.md` 全仓不存在，route-review.yml 的注释（`.github/workflows/route-review.yml:29`）却声称「与 docs/OWNERSHIP.md 保持一致」。仓库里实际有两套口径——route-review.yml 内嵌 `rules`（`:33-130`）与 `docs/TEAM-PLAN.md` 成员分工表，且两者并不一致（见下）。

2. **route-review.yml 含死前缀规则**（指向不存在的路径，永远不会命中）：
   - `docs/decisions.md`（`.github/workflows/route-review.yml:89`）——文件不存在。
   - `docs/轻单_接口契约`（`.github/workflows/route-review.yml:97`）——目录不存在。

3. **`apps/web/` owner 与 TEAM-PLAN 冲突**：
   - `.github/workflows/route-review.yml:82-83`：`apps/web/` owner = `karryL921`（赖皓妍，视觉设计）。
   - `docs/TEAM-PLAN.md:26`、`:39-44`：页面**逻辑实现**（页面代码 + 接口接线 + 测试）按业务板块归各负责人（李祖怡/温汇敏/梁海俊/黄锦城），何永上/赖皓妍「只做视觉设计，不写业务页面实现」。
   - 差异：route-review 把整个 `apps/web/` 判给设计师 `karryL921`，与 TEAM-PLAN「设计归设计、实现归实现」的口径漂移。

4. **notify 名单缺 `Meow-Yay`（次要）**：`docs/TEAM-PLAN.md:15` 成员表有 `Meow-Yay`（何永上），但 route-review.yml 的 owner/notify 全程未出现 `Meow-Yay`。

---

## 五、命令可执行性

在「Ubuntu + Node 24 + pwsh 7」环境下判断文档命令的前提是否满足（只判断，不装东西）：

| 命令 | 前置依赖 | 结论 |
| --- | --- | --- |
| `git clone` | git | ✓ 满足 |
| `corepack enable` | corepack（Node 24 自带，实测 0.36.0） | ✓ 满足 |
| `pnpm install` | 网络 + esbuild postinstall（`pnpm-workspace.yaml` 已 `allowBuilds: esbuild`） | ✓ 满足 |
| `pnpm -r build` / `typecheck` / `test` / `lint` / `openapi` | 依赖已装（`pnpm install` 后） | ✓ 满足 |
| `pwsh -NoProfile -File tests\run.ps1` | pwsh 7（实测 7.5.4） | ✓ 满足（反斜杠/正斜杠在 pwsh 下都可用，实测 `Test-Path` 均 True） |
| `pnpm -C apps/api migrate` / `seed` / `dev` | PostgreSQL 18（真实 DB） | ✗ 缺 PostgreSQL 18；`docs/DEV-SETUP.md:12` 已声明「可选，跑 migrate/seed/联调才需要」，单测用 pglite 不需要 |
| `pwsh tests\db-concurrency.test.ps1` / `e2e-business-flow.test.ps1`（L3） | `QINGDAN_TEST_DB` 真 PG | ✗ 缺真 PG；无 DB 时脚本打印 SKIP 并算通过（`docs/DEV-SETUP.md:96-98` 已声明） |
| deploy.md 的 `docker compose ...` | Docker Engine 24+ / Compose v2 | ✗ 缺 Docker；`docs/deploy.md:8` 已声明为前置条件 |

结论：核心开发命令（build/test/typecheck/lint/openapi/run.ps1）在 Node 24 + pnpm 11 + pwsh 7 下前提齐全；缺的是 PostgreSQL 18（migrate/seed/dev 与 L3 真 PG 脚本）与 Docker（部署流程）——这两项文档都已各自声明为前置条件，不算文档漏写。

---

## 建议派工表

> 归属 owner 按 issue 要求的 `docs/OWNERSHIP.md` 无法执行——该文件缺失。下表按实际生效的两份真源（`.github/workflows/route-review.yml` 内嵌规则 + `docs/TEAM-PLAN.md` 分工表）给出归属，并在首行单列「补 OWNERSHIP.md」作为先决项。

| 问题 | 影响 | 归属 owner | 预估规模 |
| --- | --- | --- | --- |
| `docs/OWNERSHIP.md` 缺失，route-review.yml 却声称与之保持一致 | 归属无单一真源，route-review 与 TEAM-PLAN 两套口径各说各话 | 主线 `TianLingBy`（.github/docs scope） | 中 |
| `docs/decisions.md` 缺失，D54/D55/D56/D59/D62/D70/D71 等口径真源无处可查 | 新成员/评审无法核对 D 编号口径，代码注释全变成悬空引用 | 主线 `TianLingBy`（TEAM-PLAN:21 红线，decisions.md 只有主线能改） | 大 |
| DEV-SETUP:57 与 vite.config.ts:49 的 changeOrigin 相反 | 403 排查说明把开发者引向错误机理 | 主线 `TianLingBy`（docs；若定代码则涉 apps/web） | 小 |
| route-review.yml 死前缀规则（`docs/decisions.md`、`docs/轻单_接口契约`） | 永不命中的规则，掩盖真实归属 | 主线 `TianLingBy`（.github scope） | 小 |
| route-review.yml `apps/web/` owner=karryL921 与 TEAM-PLAN「页面实现归业务负责人」冲突 | 前端 PR 路由/通知落到错误的人，设计师被要求审批业务实现 | 主线 `TianLingBy`（需裁定，涉 web 各业务负责人） | 小 |
| README 模块表缺 payment / report | 模块清单与实际代码不一致 | 主线 `TianLingBy`（docs） | 小 |
| TEAM-PLAN 引用不存在的 `apps/web/src/components/` 与 `prototype-v0.md` | 分工交付物指向不存在的东西 | 视觉 `Meow-Yay`（何永上）/ `karryL921`（赖皓妍），口径裁定归主线 | 小 |
| deploy.md 上线清单迁移编号停在 0026/0027 | 换机部署时漏掉 0028/0029/0030 的执行/回滚记录 | 主线 `TianLingBy`（部署运营） | 小 |
| 前端 4 页无测试（api-integration / audit / permissions / employees） | 权限域后台页回归无护栏 | `2696708617-web`（温汇敏，TEAM-PLAN:42 这些页归她） | 中 |
| 工作台 `GET /api/v1/todos`、`GET /api/v1/inventory/alerts` 契约未登记 | 工作台待办/预警功能无后端契约 | 待办=platform 主线 `TianLingBy`；预警=inventory `Vince-Leong`；页面=李祖怡 `lozy66` | 中 |
| 公司切换下拉标记「接口待做」但 `platform.company.list` 已实现 | 前端未接线，误导后续开发重复做 | 页面 `lozy66`（工作台）与布局相关页 | 小 |
| 契约注释「D54 缺口 10」已过时 | 误以为还有未实现端点 | 主线 `TianLingBy`（packages/contracts） | 小 |

---

## 验收自检

- [x] 五个小节齐全，每条结论带 `文件:行号`。
- [x] 文末给出「建议派工表」（问题 / 影响 / 归属 / 规模）。
- [x] `pnpm -r build` 全绿（本单只新增 `docs/reports/` 下一个文件，未改代码）。
- [x] `pwsh -NoProfile -File tests/run.ps1` 全绿（见下）。

验证命令结果：

```text
pnpm -r build                           → BUILD_EXIT=0
pwsh -NoProfile -File tests/run.ps1     → ALL PASSED (7 files)，RUN_EXIT=0
  （其中 apps/api 测试 70 文件 / 481 项全部通过）
```
