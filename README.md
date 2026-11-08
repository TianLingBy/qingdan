# 轻单（工程仓）

面向中小企业的「订单成本核算 + 进销存」SaaS。单仓全栈 TypeScript：Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite + pnpm 11。

> 本仓是**代码仓**。产品口径、接口契约、团队分工与检查点等内部文档不在公开仓内维护。

## 快速开始

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan

# 1) 装本地护栏：把受控 pre-commit 装进 .git/hooks，并当场跑一遍全量测试
pwsh -NoProfile -File install-hooks.ps1

# 2) 依赖（需要 Node 24 + pnpm 11）
corepack enable
pnpm install

# 3) 构建与测试
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests\run.ps1
```

macOS / Linux 把 `install-hooks.ps1` 换成对应步骤即可（hook 源文件 `tools/pre-commit` 保持 LF）。

## 目录

```
apps/
  api/                 Fastify 5 + Drizzle + PostgreSQL 18（唯一部署物）；src/platform 放权限/审计/取号
  web/                 React 19 + Vite（后续 Electron / Capacitor 复用同一产物）
packages/
  contracts/           ★ 唯一契约包：Zod 4 注册表 → OpenAPI 3.1 / CLI 命令树 / MCP 工具表（同源）
  cli/                 qingdan CLI（薄 HTTP 客户端）
  mcp/                 MCP Server（工具与 REST 一对一，不绕权限与审计）
tests/                 PowerShell 契约测试，入口 tests/run.ps1
tools/                 受控工具：pre-commit hook 源文件
docs/                  OpenAPI 说明书、ADR、spike 与模块模板；`docs/members/` 放成员档案（复制 `_template.md` 填）
```

## 本地运行

```powershell
# 后端（默认 http://127.0.0.1:3000/api/v1）
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/qingdan_dev'
pnpm -C apps/api migrate
pnpm -C apps/api seed
pnpm -C apps/api dev

# 前端（http://127.0.0.1:5173，/api 代理到 3000）
pnpm -C apps/web dev

# 接口真源（OpenAPI 3.1）
pnpm openapi
```

接口唯一真源是 `packages/contracts` 的 Zod 注册表，`docs/api/openapi.yaml` 由它生成，不要手写。

## 测试与 CI

- 本地：`pwsh -NoProfile -File tests\run.ps1`（退出码 0 才算通过），pre-commit 跑的是同一入口。
- CI：`.github/workflows/test.yml` 在 `windows-latest` 与 `ubuntu-latest` 跑同一入口，另有真 PostgreSQL 的集成 job 与 e2e job；`spec-drift` 校验 `pnpm openapi` 后无漂移。

## 分支与协作

- `main` 只接受 PR；每个模块一条 `feat/<模块名>` 分支。
- 提交前必须本地门禁全绿；PR 模板见 `.github/pull_request_template.md`。
- 外部贡献走 fork + PR；合并权在维护者。

## 模块

| 顺序 | 模块 | 范围 |
|---|---|---|
| P0 | `platform` | 登录、租户·公司·员工、权限引擎、编号、审计、审批、单据框架、待办 |
| P1 | `masterdata` | 商品、客户、供应商、加工厂 |
| P1 | `inventory` | 批次、库存数量、库存流水、盘点调整、成本更正 |
| P2 | `purchase` | A 采购单 + S 供应商退货 |
| P2 | `processing` | B 加工单 + 损失记录 |
| P3 | `sales` | E 销售单 + 收款记录 + 在线支付 + R 客户退货 |
| P3 | `internal-trade` | N 内部交易单 + 内部定价 |
| P4 | `settlement` | C 结算单 + 提成 + 利润报表 |

## 许可

AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
