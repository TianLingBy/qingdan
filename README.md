# 轻单（工程仓）

面向中小企业的「订单成本核算 + 进销存」SaaS 工程仓。需求稿真源仓 `D:\Desktop\dsh\轻单` 已于 2026-11-03 迁移完成后冻结，**阶段 4 起开发与文档变更都在本仓**。

## 首次接入（协作者 / 任意 Agent）

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>
```

一条命令完成：装 pre-commit hook、跑全量测试、建 `feat/<模块名>` 分支。macOS/Linux 用 `./bootstrap.sh <模块名>`。

模块清单、分工与依赖顺序、完成定义（DoD）、失败处置、各 Agent 入口见 [`docs/ONBOARDING.md`](docs/ONBOARDING.md)。

## clone 之后第一步

```powershell
pwsh -NoProfile -File install-hooks.ps1
```

`.git/hooks` 不进版本控制，不跑这行就没有任何测试护栏（装了之后每次 commit 都会跑全量测试，测试不过直接拦下）。脚本会把受控的 `tools/pre-commit` 装进 `.git/hooks/`，并当场跑一遍测试确认能通过。

## 常用命令

```powershell
# 全量测试（hook 调的就是这个）
pwsh -NoProfile -File tests\run.ps1

# 只跑某个测试文件
pwsh -NoProfile -File tests\requirements.test.ps1
```

## 目录

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | 项目规则（阶段、检查点、开发约定、路由、测试、禁止事项）。**新会话先读它** |
| `docs/README.md` | 文档索引与阅读顺序（含模块表） |
| `docs/decisions.md` | **已拍板口径唯一索引（D1-D50）**，每阶段开发前必读 |
| `docs/轻单_接口契约第一批_v1_20261103.md` | A/B/E/C 主链 + 批次 + 库存流水（已冻结） |
| `docs/轻单_接口契约第二批_v1_20261103.md` | N 单 + 提成 + 内部定价（已冻结） |
| `docs/prototype-v0.md` | 原型规格：22 页 IA、权限矩阵、数据模型 |
| `prototype.html` | 可点击原型（单文件，双击即开） |
| `docs/module-*.md` | 每个模块的长期检查点（目标/范围/依赖/开放项/验收/进度） |
| `docs/raw/` | 飞书原文，**只搬不改写**；协议见 `docs/raw-protocol.md` |
| `tools/` | 受控工具：pre-commit hook 源文件 |
| `tests/` | 测试；`*.test.ps1` 由 `tests/run.ps1` 逐个拉起 |

## 阶段

1 原料搬运 → 2 上下文 → 3 原型与契约 → 4 分工开发（**当前**）→ 5 合并迭代。

## 远程与协作

- 远程仓库：`https://github.com/TianLingBy/qingdan`（私有，GitHub）。
- 分支：`main` 只接 PR；每个模块一条 `feat/<模块名>` 分支。
- CI：`.github/workflows/test.yml`（push main / PR 时在 `windows-latest` 跑 `tests/run.ps1`）。
- 本地护栏：`install-hooks.ps1` 装的 pre-commit 与 CI 跑同一入口，双保险。

## 模块与开工顺序

| 顺序 | 模块 | 范围 |
|---|---|---|
| P0 | `platform` | 登录/入企、租户·公司·员工、权限引擎、编号、审计、审批、单据框架、待办、打印导出框架 |
| P1 | `masterdata` | 商品、客户、供应商、加工厂 |
| P1 | `inventory` | 批次、库存数量、库存流水、盘点调整 I、成本更正 |
| P2 | `purchase` | A 采购单 + S 供应商退货 |
| P2 | `processing` | B 加工单 + 损失记录 |
| P3 | `sales` | E 销售单 + 收款记录 + 在线支付 + R 客户退货 |
| P3 | `internal-trade` | N 内部交易单 + 内部定价 |
| P4 | `settlement` | C 结算单 + 提成 + 利润报表 |

映射规则：D44 的 19 个功能域按「原单方向」归模块——R 归 `sales`、S 归 `purchase`、I 归 `inventory`，不单独立一个「冲正」模块。
