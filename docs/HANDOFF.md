# 交接说明（HANDOFF）

> **用途**：新会话接手时**第一个读的文档**。它只写「现在在哪、下一步做什么、坑在哪」，口径细节仍以
> `docs/decisions.md`、`docs/module-*.md`、`docs/roadmap.md` 为准（本文不复制口径，避免两处漂移）。
> **维护规则**：每次一段工作结束、或换会话前更新一次；过期内容直接改掉，不堆历史（历史看 `docs/roadmap.md` 变更记录）。

## 0. 一分钟读完

- 仓库：`D:\Desktop\dsh\Qingdan`，远程 `github.com/TianLingBy/qingdan`（**私有**），默认分支 `main`。
- 当前阶段：**阶段 4 分工开发**；主线 `platform` 的 M1 已完成（11 个端点可用），`masterdata` 的商品 5 端点已登记并能挂载（D62），其余业务模块尚未开工。
- 团队：DSH=中间人（拆任务/派活/验收/提交），**代码 → Claude Code**，**杂项（文档/脚本/CI）→ Codex**；人类 4 人（温汇敏=账号权限、赖皓妍=UI、李祖怡=单据展示、梁海俊=后端业务）。
- 现在的堵点：① 赖皓妍的仓库邀请**待接受**；② 温汇敏、赖皓妍、李祖怡**档案未落盘**（按规则不算开工）；③ 任务板 #3/#4/#5/#6/#10 全在等她们。

## 1. 最近状态（截至 2026-11-04 深夜）

| 项 | 值 |
|---|---|
| 最新合并 | `f42ae89` feat(contracts): 商品 5 端点 + Product 实体，路由按模块挂载（D62，Issue #15）；其后 `docs(onboarding)` GitHub MCP 一节（#21） |
| main 上 CI | 最近一次 push 三 job 全绿（`test (windows-latest)`/`test (ubuntu-latest)`/`integration (PostgreSQL 18)`） |
| 测试基线 | `apps/api` **122 例**、`packages/contracts` **48 例**、全量门禁 `tests\run.ps1` → `ALL PASSED (7 files)` |
| 工作树 | 干净（交接前确认） |
| 协作者 | `TianLingBy`(负责人)、`Vince-Leong`(梁海俊)、`2696708617-web`(温汇敏)、`lozy66`(李祖怡)；`karryL921`(赖皓妍) **邀请待接受** |
| 已合并的成员档案 | 仅**梁海俊**（#13）。温汇敏/赖皓妍/李祖怡只有预填档案，本人未确认 |

## 2. 已完成（不用重做）

- **M0 工程骨架**：`apps/api`（Fastify 5 + Drizzle）、`apps/web`（React 19 + Vite）、`packages/contracts|cli|mcp`；CI 双平台 + PostgreSQL 18 集成 job。
- **M1 platform 核心**：登录/登出/me、API Token 建查撤、操作日志查询、员工个人级权限覆盖、员工列表；认证内核（会话 Cookie 7 天滑动续期、Bearer 优先、同源 CSRF、`TRUST_PROXY` 默认不信任代理头）、审计 outbox、5 个 SECURITY DEFINER 函数、审计只读视图。审查 7 项整改（D59/D60）已落地。
- **员工列表 `GET /api/v1/employees`**（手机号脱敏，非老板只看绑定公司）。
- **商品 5 端点（D62）**：`GET/POST /api/v1/products`、`GET/PATCH/DELETE /api/v1/products/{id}`，归 `masterdata`；顺带把「路由归属模块化」做进 `packages/contracts`（`module` 字段 + `routesOfModule` + `apps/api/src/modules/index.ts` 的 `MOUNTED_MODULE_KEYS`）。
- **开源准备**：AGPL-3.0 落地（`LICENSE` + `package.json` license，D61 记录私有仓开发/公开仓历史从零/文档三级分类/发布前敏感扫描）；CLI 文档对齐注册表；CI 口令改仓库 secret `PG_TEST_PASSWORD`（未配置时回退本地默认值）。
- **流程类**：CI 里 PGlite 测试按文件串行（不再偶发 Hook 超时）；`.claude/settings.json` 授权 Claude Code 写文件（外部改动已登记）；合并权分级（普通 PR 由 Lead 自合并，严重变更交负责人，见 `docs/AGENT-TEAM.md` §6.1）。
- **身份核验门禁**：`docs/ONBOARDING.md` 新增 §0.0「第 0 步：核验你是谁」（问 3 个问题 + 3 处交叉核对 + 处置表）与 §4.1「领任务」；`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursor/rules/qingdan.mdc`、`.github/copilot-instructions.md` 各加一条第 0 步指针；`docs/members/README.md` 同步该节并修正梁海俊状态为「档案已合并（#13）」。**原因**：协作者的 Agent clone 完不知道自己要干嘛，会直接瞎改。

## 3. 任务板（GitHub Issues，仓库里能看到）

| Issue | 内容 | 状态 |
|---|---|---|
| #3 | 赖皓妍：成员档案落盘（开工前置） | OPEN，等本人（还需先接受仓库邀请） |
| #4 | **登录页**（P0，接口已就绪，做完即可真联调） | OPEN |
| #5 | 工作台（占位数据定版式） | OPEN |
| #6 | 员工页视觉骨架 + 个人权限覆盖面板（员工列表接口已可用） | OPEN |
| #10 | 温汇敏：成员档案落盘 + 账号/权限域接手 | OPEN |
| #15 | 商品首切契约与路由挂载 | ✅ 已关闭 |
| #14 | 梁海俊：档案落盘 + 后端接手 | ✅ 已关闭 |

## 4. 下一步（建议顺序，可调整）

1. **主线：masterdata 剩余三块**（客户 / 供应商 / 加工厂）——照商品那 5 端点的样板做，商品可以先用来验证样板是否够用。依据 `docs/module-masterdata.md`。
2. **M1-F 端到端**：把「CLI 登录 → `/auth/me` → 一次写操作 → 查审计有记录」放进 CI 的 `postgres:18` job；本机没装 PG（建议装 PG18 后本地也能跑）。
3. **开发者后台 `/api/v1/admin/**`**（D54⑤，`actorType=platform`、账号独立体系）与平台级审计（`tenant_id IS NULL` 的行目前只写不读）。
4. **前端三页**：#4 登录页优先（接口已就绪）→ #5 工作台 → #6 员工页；等赖皓妍档案落盘后她那边的写范围是 `apps/web/src/**`。
5. **开源落地剩余**：CLA/DCO 规则、公开仓创建与首条干净历史、公开发布 MANIFEST + 敏感词扫描脚本、依赖许可证扫描。

## 5. 坑（踩过，别再踩）

- **迁移 `0002_platform_m1.sql` / `0003_platform_preset_key.sql` 已是「已发布形态」**：任何环境部署过后不得再改历史迁移，新增一律开新文件（`0004+`）。
- **`security_invoker` 视图读不了基表**：审计查询视图必须是属主权限视图 + 显式租户谓词（D59①），别改回去。
- **`TRUST_PROXY` 默认 `false`**：部署到反代后必须显式配可信网段，否则 `request.ip` 是反代地址，`ip_allowlist` 与审计 IP 都不准；反过来无脑 `trustProxy: true` 就能被 `X-Forwarded-For` 伪造（曾是被审查出的 P1）。
- **失败审计的统一 catch 在 `modules/platform/routes.ts` 外层**：用例调用必须 `return await xxx()`，否则 Promise 拒绝绕过 catch、失败日志静默丢失；已有用例自己记失败审计时要 `markFailureAuditRecorded` 去重。
- **PGlite 测试必须按文件串行**（`apps/api/vitest.config.ts`）：并行会偶发 `Hook timed out`，全量约 27 秒属正常。
- **契约变更顺序**：先 `docs/decisions.md` + 契约文档 → 再 `packages/contracts` → 最后 `apps/api`；`docs/api/openapi.yaml` 是生成物，不要手改。
- **`suggest` 不要凭记忆**：新会话先读 `docs/README.md` 与本文，口径以 `decisions.md` 为准。
- **派活硬规则**：自包含（绝对路径 + 写范围 + D 编号 + 验收命令）、单次 180 秒超时、子代理只写不提交；提交/合并归 Lead。
- **GitHub 偶发 500**：`git push` 报 `Internal Server Error` / `fatal error in commit_refs` 时，等待 5–15 秒重试即可（本日遇到 3 次，均重试成功）。

## 6. 需要负责人拍板 / 补的

- 李祖怡、温汇敏、赖皓妍三人的**档案**：需要本人确认后提交 PR（温汇敏/李祖怡账号已登记：`2696708617-web`、`lozy66`；赖皓妍 `karryL921` 邀请待接受）。
- **CLA / DCO** 是否要求（影响将来能否改协议或卖商业双许可）。
- **公开仓**名字、是否公开演示站、首次发布快照的清洗清单。
- 是否**本机装 PostgreSQL 18**（否则端到端只能靠 CI）。
- 「先功能后视觉」是否接受（决定主线能否先做前端壳接接口、不等视觉稿）。

## 7. 交接前自检命令

```powershell
cd D:\Desktop\dsh\Qingdan
git status --short            # 应为空
pwsh -NoProfile -File tests\run.ps1    # 期望 ALL PASSED (7 files)，exit 0
gh pr list --state open       # 交接时应为空
gh issue list --state open    # 应只有 #3 #4 #5 #6 #10
```

## 8. 给新会话的开场话（可直接粘贴）

```text
接手「轻单」工程仓（D:\Desktop\dsh\Qingdan）。先读 docs/README.md，再读 docs/HANDOFF.md（交接说明，含当前状态、
任务板、下一步与已知坑），然后按 docs/AGENT-TEAM.md 的路由干活：DSH 只做拆任务/派活/验收/提交合并/汇报，
代码派 conductor_dispatch(agent:"claude-code")，文档与脚本派 conductor_dispatch(agent:"codex")，
子代理只写不提交、单次派发 ≤180 秒、任务必须自包含并带验收命令。

接着做：主线 masterdata 的客户/供应商/加工厂（照商品 5 端点样板），然后 M1-F 端到端放 CI 的 postgres:18 job。
任务板：#3/#4/#5/#6 是赖皓妍（前端与档案，#4 登录页最急），#10 是温汇敏（账号权限域 + 档案）。
注意：契约变更先改 docs/decisions.md；迁移不许改历史文件；坑见 HANDOFF §5。
```
