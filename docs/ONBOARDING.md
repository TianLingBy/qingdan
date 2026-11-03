# 轻单 · 协作者一键接入（任何 Agent 通用）

> **这是唯一入口。** 不管协作者用的是 Claude Code / Codex / Cursor / GitHub Copilot / Gemini CLI 还是别的 Agent，都先读这一份，再按 §2 跑一次初始化。
> 规则真源永远是 `AGENTS.md` + 本文件；下面 §8 那些 Agent 专属文件只是指针。

## 0. 完成定义（怎样算「初始化好了」）

一次接入做完，应该同时满足这五条：

1. `tests\run.ps1` 能跑、全绿；
2. `.git/hooks/pre-commit` 已装（提交前自动跑测试）；
3. 已在自己负责模块的分支上（`feat/<模块名>`）；
4. 模块检查点 `docs/module-<模块名>.md` 的「当前状态」已认领；
5. 知道自己下一步写什么（模块的「开放项 + 验收标准」）。

## 0.1 人类开发者请走这条线

如果你是被邀请来的**人类协作开发者**（本项目 4 人小组），除了本文件，还必须读这两份：

1. `docs/ROLES-AND-BOUNDARIES.md` —— 谁能做什么、不能做什么、灰区谁批、文件级写权限（先看这份，避免越界）。
2. `docs/TEAM-PLAN.md` —— 你负责哪几个模块、第 1 周具体做什么、DoR/DoD、人机互评与升级规则。
3. `docs/DEV-SETUP.md` —— 本机环境（Node 24 / pnpm 11 / PostgreSQL 17）、仓库骨架与目录边界、本地起服务、测试分层。

技术栈按 `docs/adr-0001-tech-stack.md` 的推荐方案（TypeScript 全栈），D53 拍板前视为待定。

## 1. 硬前置

- **git**（任意较新版本）
- **PowerShell 7+**（命令名 `pwsh`，**不是** Windows 自带的 `powershell` 5.1；测试与 hook 都靠它）
- 网络（仓库是 GitHub 私有仓，需要先被邀请）

检查：

```powershell
pwsh -v          # 期望 7.x
git --version
```

没有 pwsh 7 时：Windows `winget install Microsoft.PowerShell`；macOS `brew install --cask powershell`；Ubuntu 走微软官方 apt 源。**不要用 5.1 兜底**——本仓 `.ps1` 带 BOM，但 5.1 仍会在部分场景按 GBK 解码中文报 `The string is missing the terminator`。

## 2. 一键初始化（推荐，所有 Agent 都能照抄）

```powershell
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan

# 只做环境（装 hook + 跑全量测试）
pwsh -NoProfile -File bootstrap.ps1

# 环境 + 建自己的模块分支（取下面 §4 表格里的模块名）
pwsh -NoProfile -File bootstrap.ps1 -Module platform
```

macOS / Linux：

```bash
git clone https://github.com/TianLingBy/qingdan.git
cd qingdan
./bootstrap.sh                 # 只做环境
./bootstrap.sh platform        # 环境 + 建 feat/platform 分支
```

脚本做的事（**幂等，可以重复跑**）：
① 校验在仓库根 → ② 校验 pwsh 7 / git → ③ 调 `install-hooks.ps1` 装 hook 并跑全量测试 → ④ 带 `-Module` 时校验模块存在并建/切 `feat/<模块>` → ⑤ 打印认领清单与必读顺序。

成功标志：最后一行是 `BOOTSTRAP-OK`。

## 3. 手动版（Agent 不能执行脚本时，逐条照做）

```powershell
pwsh -NoProfile -File install-hooks.ps1      # 装 hook，并自动跑一遍测试
pwsh -NoProfile -File tests\run.ps1          # 再跑一次，确认 ALL PASSED (N files)
git switch -c feat/<模块名>                  # 建分支（已存在就 git switch feat/<模块名>）
```

然后打开 `docs/module-<模块名>.md`，把「当前状态」改成：`进行中（<你的名字>，YYYY-MM-DD）`。

## 4. 分工与分支

功能域按「原单方向」归模块（D44 的 R/S/I 不单独立模块）：R 归 sales、S 归 purchase、I 归 inventory。

> **交付模块划分（定稿）**：主线（platform/sales/settlement）+ M1 主数据与采购 + M2 库存与盘点 + M3 加工与损耗 + M4 内部交易与打印，负责人与写范围见 `docs/TEAM-PLAN.md` §0/§1；下表是**代码子模块**与分支名，具体归哪条交付模块看 §0。

| 模块（分支名） | 负责范围 | 依赖 | 负责人 |
|---|---|---|---|
| `platform`（`feat/platform`） | 登录/入企、租户·公司·员工、权限引擎（D4/D15/D50）、编号（D16/D48）、审批、单据框架（三态/取消级联）、待办流转、打印导出框架、链路视图、**操作日志（D51）**、**API 与集成（D52：OpenAPI/CLI/MCP/API Token/危险动作开关）**、平台运营后台 | 无（P0，所有模块都等它） | 待认领 |
| `masterdata`（`feat/masterdata`） | 商品、客户、供应商、加工厂 | platform | 待认领 |
| `inventory`（`feat/inventory`） | 批次（锁价/占用/可用量/保管人）、库存数量、库存流水、盘点调整 I、成本更正 T1/T2/T3 | platform、masterdata | 待认领 |
| `purchase`（`feat/purchase`） | A 采购单、S 供应商退货 | platform、masterdata、inventory | 待认领 |
| `processing`（`feat/processing`） | B 加工单、损耗、全损耗损失记录、归属单 | platform、masterdata、inventory | 待认领 |
| `sales`（`feat/sales`） | E 销售单、改价下限审批、收款记录、客户在线支付、R 客户退货 | platform、masterdata、inventory | 待认领 |
| `internal-trade`（`feat/internal-trade`） | N 内部交易单、内部定价、在途锁定/签收转司 | platform、masterdata、inventory | 待认领 |
| `settlement`（`feat/settlement`） | C 结算单、提成、利润报表 | sales、processing、internal-trade | 待认领 |
| `test`（`feat/test`） | 测试底座与契约测试（通常由平台负责人兼） | 无 | 待认领 |

**开工顺序**：platform →（masterdata ∥ inventory）→（purchase ∥ processing）→（sales ∥ internal-trade）→ settlement。
依赖没就绪时**不要开工**，先在自己的检查点里写「被 X 阻塞 + 需要的接口签名」，等对方合入。

约定：

- **一个模块一个负责人**；一个 PR 只碰本模块写范围。
- 跨模块改动（公共类型、权限、库存/金额口径、`docs/decisions.md`）必须在 PR 描述里列受影响模块并 @ 对应负责人。
- `main` 不直推（免费私有仓无法强制保护，靠 CI 红不合并 + 评审约定兜底）。
- 合并前至少一次评审；AI 做第二意见可以用 `claude-code`。

## 5. 必读文档（最小集，约 15 分钟）

按顺序读，不要通读 41KB 的 `decisions.md`：

1. `docs/README.md` —— 文档索引与模块表（5 分钟，知道什么在哪儿）。
2. `docs/module-<你的模块>.md` —— 你的边界、依赖、开放项、验收标准（最重要）。
3. `docs/decisions.md` §1 —— **只读你模块检查点「相关文件」列出的 D 编号**。
4. 对应契约章节：`docs/轻单_接口契约第一批_v1_20261103.md`（A/B/E/C + 批次 + 流水）或 `第二批`（N + 提成 + 定价）；**platform 另读 `docs/轻单_接口契约第三批_v1_20261104.md`（操作日志 / API Token / 通用 API 约定，草案待冻结）**。
5. `docs/prototype-v0.md` §2 —— 你模块对应页面的职责与状态。

**不需要读**：`docs/raw/`（飞书原文，追溯时才用）、`轻单_阻塞问题决策清单`（讨论过程，结论已在 decisions）、`project-context.md`（除非你要动架构/部署）。

## 6. 干活与交付（DoD）

1. **开放项先拍板**：模块检查点「开放项」里的每一条，开工前定下来 → 追加到 `docs/decisions.md`（只追加，不改历史行）→ 同步改契约里该条的标记 → 再写代码。
2. **不猜口径**：没拍板的写 `TODO(未定)`，不要用假设悄悄实现。
3. **每周/每段落更新检查点**：`docs/module-<模块名>.md` 的已完成 / 进行中 / 下一步 / 坑。
4. **提交前**：`pwsh -NoProfile -File tests\run.ps1` 必须 exit 0；hook 会自动再跑一次。
5. **开 PR**：按 `.github/pull_request_template.md` 填，CI（GitHub Actions）绿了再找人评审。
6. **合并后**：删本地分支，从 `main` 重新拉下一段。

## 7. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `pre-commit: 找不到 pwsh` | PATH 上没有 PS7 | 装 pwsh 7；hook 会报错阻止提交，不会静默放行 |
| `The string is missing the terminator` | 用 5.1 跑了带中文的 `.ps1` | 一律 `pwsh`；新写的 `.ps1` 必须带 BOM |
| `/bin/sh: ./pre-commit: bad interpreter` | hook 被转成 CRLF | `.gitattributes` 已钉 LF；重跑 `install-hooks.ps1` |
| 测试红 | 改了契约/检查点断言 | 先看 `tests\run.ps1` 报哪个文件哪条断言；**不要 `--no-verify` 绕过** |
| `403` / 无权推送 | 没被邀请进私有仓 | 找仓库所有者加协作者（write 权限） |
| `bootstrap.ps1` 报模块不存在 | 模块名拼错 | 用 §4 表格里的名字，全小写、连字符 |

## 8. 各 Agent 的入口对照

| Agent | 先读的文件 | 说明 |
|---|---|---|
| Claude Code | `CLAUDE.md` | 指向本文件与 `AGENTS.md` |
| Codex | `AGENTS.md` | 项目规则主体 |
| Cursor | `.cursor/rules/qingdan.mdc` | `alwaysApply` 规则，指向本文件 |
| GitHub Copilot | `.github/copilot-instructions.md` | 指向本文件 |
| Gemini CLI | `GEMINI.md` | 指向本文件 |
| 其他 / 自定义 Agent | `AGENTS.md` → 本文件 | 规则真源，不要只读指针文件 |

**给 Agent 的一句话指令**（可直接粘贴给任意 Agent）：

> 克隆 https://github.com/TianLingBy/qingdan.git 到本地，读仓库根的 AGENTS.md 与 docs/ONBOARDING.md，运行 `pwsh -NoProfile -File bootstrap.ps1 -Module <模块名>` 完成初始化；然后按 docs/module-<模块名>.md 的开放项与验收标准开始开发，提交前跑 `tests\run.ps1`。

## 9. 卡住时找谁

- 仓库所有者 / 总负责：`TianLingBy`（GitHub）。
- 口径问题：先查 `docs/decisions.md`；查不到就在 PR 说明里写「需要拍板：问题 + 两个候选方案」，不要自己发明。
- 提 issue / PR 时写清：模块名 + 执行过的命令 + 完整报错输出。
