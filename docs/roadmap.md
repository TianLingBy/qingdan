# 轻单 · 路线与阶段检查点

> **这份文件兼任两件事**：① 阶段路线；② 阶段 1-3 的检查点（规则见 `AGENTS.md`「阶段与检查点」）。
> 阶段 4 开始分模块开发后，进度改记到 `docs/module-<模块名>.md`，本文件只留路线。
> 每完成一个可交付段落**立刻**更新本文件，不要只留在对话里。

## 目标

轻单第一版：面向中小型企业的「订单成本核算 + 进销存」SaaS（行业中立数据模型，家具/建材锚定），**Web 优先**，按「原型 → 分工 → 合并 → 迭代」推进。
验收口径：原型能让团队对齐、接口契约能冻结、分模块并行开发能合并。

## 阶段路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 原料 | 飞书知识空间搬入 `docs/raw/`，只搬不改写 | ✅ 完成 |
| 2 上下文 | `docs/project-context.md`（已知/推断/未知三层）+ 原型规格 `docs/prototype-v0.md` | ✅ 完成 |
| 3 原型与契约 | 可点击原型 `prototype.html` → 用户划改 → 冻结数据模型与接口契约 | ✅ 完成（**决策已收口 D1-D50**；原型已按 20 页新 IA 重排；契约两批已冻结，含 10 项开放项交同事开发阶段定） |
| 4 分工开发 | 模块登记进 `AGENTS.md`，每模块一份 `docs/module-<名>.md`，并行开发 | 🔄 进行中（9 个模块已登记，**技术栈 D53 + 底座 D55/D56/D57 已收口**；**M0 工程骨架 2026-11-04 已建立**，P0 `platform` 进入 M1 实现） |
| 5 合并迭代 | 合并回主干，再扩展或修改功能 | ⬜ 未开始 |

## 当前状态

**阶段 4 进行中（2026-11-04 M0 骨架已建立）**：monorepo 落地（`apps/api` Fastify5 + Drizzle + PG18、`apps/web` React19 + Vite + Tailwind4、`packages/contracts` Zod 注册表 → OpenAPI 3.1 / CLI / MCP），迁移 `0001_platform_core.sql`（13 表 + RLS + 只追加审计）、并发取号、权限判定一条 SQL、统一错误体与 `X-Request-Id` 全部就位；全量门禁 `tests\run.ps1` 绿（7 个测试文件，其中 vitest 130 例：contracts 39 / api 43 / web 26 / cli 17 / mcp 5），CI 加 Node 24 + pnpm 11 与 ubuntu + `postgres:18` 集成 job。**10 个平台端点已登记但 handler 仍 501** → 下一步 M1 实现登录/会话/Token/审计查询/权限覆盖。此前 2026-11-03 交接：需求稿已从归档仓 `D:\Desktop\dsh\轻单` 迁入本仓 `docs/`，归档仓冻结只读；模块切分为 8 个业务模块 + `test`；D51/D52/D52.1（操作日志 + AI 友好）与 D54（契约第三批冻结）、D55（技术底座五项）、D56（Win10 浏览器基线）、D57（U12 spike 三条工程约束）均已落 `docs/decisions.md`。

阶段 3 已收口，历史状态如下：**决策层已收口**：2026-11-03 项目负责人分七轮把 **D1-D50** 全部拍板（对外 SaaS / 六类单据全量进一期 / 预设岗位+自定义岗位 / 单头三态+行状态 / 成本随批次锁定 / 报价单删+货物位置二期 / 可视化=业务全流程图 / 流转表驱动待办 / 客户在线支付 / 编码固定结构 / C 单生成时机 / 取消级联 / 批次归属 / 损失报表口径 / 错账路径 / 损失归属 / 重开提成 / 成本更正 / 库存可用量 / 费用行正负 / 仅退款重算 / 待执行占用 / 成本更正审批 / 利润报表 / 功能域清单 / 集团看板一期不做 / 20 页重排 / 矩阵特殊值映射 / 个人编号 / 业务档案编号边界 / 员工个人级权限覆盖 等），结论见 `docs/decisions.md`。
真源口径已定（D0）：v1 交接文档是 L1/L2 口径真源，仓库 `docs/` 是产出层；`roadmap.md` 原「原型已交付」的表述按 D0 修正为「原型已产出、待按新 IA 重排」。
剩余：① 原型已按 20 页新 IA 重排（`prototype.html` v1，待划改）；② 契约两批**已冻结**（第一批 A/B/E/C+批次+流水、第二批 N+提成；各含开放项交同事定）；③ 遗留未决剩 1 条（`decisions.md` §3：L9 一单真实成交数据 M1，等待真实订单数字）。
2026-11-03 转交决策：负责人拍板「**先冻结契约 → 迁入工程仓 → 分模块开发**」，契约 10 项开放项（第一批 5 项 + 第二批 5 项）**交由同事在开发阶段决定**，不阻塞冻结；模块切分由负责人定、AI 落文档。
2026-11-03 第四轮：与负责人逐条确认 12 项契约口径，新增 **D19-D28**（C 单生成时机、改价下限取数、取消级联、批次归属、微信授权收尾、收款台账位置、跨司链路、损失报表口径、损失可见性、含税口径），详见 `docs/decisions.md`；M2 补登记进等材料清单。
2026-11-03 第四轮检查收尾：交叉核对发现 6 处口径空洞，已逐条拍板为 **D29-D34**（N 单 C 单时机、错账路径不设 J、在途批次锁定、费用行跳过下限、C 单损失净毛利展示、退款负数行记账），详见 `docs/decisions.md`。
2026-11-03 第五轮：检查发现 5 处口径空洞，已拍板为 **D35-D39**（C 单损失归属改为 B 单显式挂「归属单」、错账重开必须全额冲回且原单提成归零、成本侧录错按引用状态分 T1/T2/T3、库存页四列含可用量、费用行正负按单据类型分开），详见 `docs/decisions.md`。
2026-11-03 第六轮：逐项确认契约收尾，拍板 **D40-D47**（仅退款与 C 单重算边界、待执行占用生命周期、成本更正审批人、利润报表与未归属损失下钻、一期功能域清单、集团看板一期不做、20 页重排确认、矩阵特殊值映射），详见 `docs/decisions.md`。
2026-11-03 第七轮：确认权限模型加「员工个人级」覆盖，拍板 **D50**（经理/老板给单个员工单独增减权限，叠加在岗位并集之上，经理不可改老板/财务/其他经理），权限设置页同步加「按员工单独配置」维度，详见 `docs/decisions.md`。

## 已完成

- **阶段 1**：飞书知识空间「掌单产品基础功能结构」11 个节点搬入 `docs/raw/掌单产品基础功能结构/`，写入 11 / 跳过 0 / 失败 0。凭证只走 `~/.dsh/feishu-export.json`。
- **阶段 2**：`docs/project-context.md`（含 9 节：一句话、组织方式、业务领域、空间结构、协作方式、交付形态、开发路线、未知、约束）；`docs/prototype-v0.md`（13 页清单、权限矩阵复原、数据模型 v0、状态机）。
- **阶段 3 初稿**：`prototype.html` 单文件可点击原型，13 页、假数据、切身份后菜单与按钮按权限矩阵真实变化，支持 `?role=拣货#orders` 深链。用无头 Edge 截图验证过 3 个页面。
- **工具链**：`tests\run.ps1` 12 项 PASS；`.git/hooks/pre-commit` 已装并调用同一入口。
- **工作流护栏**：新增 `tests\roadmap.test.ps1`，把「阶段检查点存在 / 七小节齐全 / 当前状态已填 / 五阶段齐全 / 变更记录有日期 / 外部依赖有回滚列 / AGENTS.md 写了规则」变成断言，随 `pre-commit` 强制生效。全量测试由 1 个文件变 2 个，23 项 PASS。
- **hook 双向验证**：正常时 `pre-commit: 测试通过。` exit 0；注入一条必失败用例后 `FAILED (_tmp-hook-block.test.ps1)` + `pre-commit: 测试未通过，提交已阻止` exit 1，临时用例已删除、未留残余。
- **搬运工具入库**：`tools\feishu-wiki-export.cjs` 已纳入仓库（原始位置同 SHA-256），`--self-test` 通过；原始位置另有 `.bak-20261103` 快照。
- **raw 区净化**：`docs/raw/README.md` 移出并改名为 `docs/raw-protocol.md`；`docs/raw/` 现在只剩 11 篇原文 `.md`，无非原文文件（已由 `tests/roadmap.test.ps1` 断言）。
- **hook 可复刻（团队闭环）**：hook 源文件 `tools/pre-commit` 纳入 git（与已装版本 SHA-256 一致）；`install-hooks.ps1` 一键安装（取 `git rev-parse --git-path hooks` 兼容 worktree、强制 LF 写入、POSIX 下补可执行位、装完自检哈希并跑全量测试）；`.gitattributes` 钉死 `tools/pre-commit text eol=lf`，避免本机 `core.autocrlf=true` 在 clone 时把 hook 转成 CRLF 导致 `bad interpreter`；`README.md` 与 `AGENTS.md` 写明 clone 后第一件事就是跑它。实测：删掉 `.git/hooks/pre-commit` 模拟新 clone（测试输出 `SKIP 未安装 hook`、其余 33 项 PASS），再跑 `install-hooks.ps1` → 恢复、哈希一致、34 项 PASS、exit 0。

## 进行中

- **阶段 4 · M1 platform 核心可用（2026-11-04 完成）**：注册表里 10 个 platform 端点**全部实现**（登录/登出/me、API Token 建查撤、操作日志查询、员工个人级权限覆盖写入），鉴权、同源 CSRF、审计、ETag 乐观锁、dryRun 全部接上；迁移 `0002_platform_m1.sql` 落 5 个 SECURITY DEFINER 函数 + 审计只读视图 + 两处 `version` 列；`apps/api` 测试 46 → **97** 例，全量门禁 `ALL PASSED (7 files)`。技术裁定记 **D59**（审计读路径、登录跨租户查找、验证码、业务时区、取号粒度、`is_owner`、会话实现、CSRF）。**未验证**：真实 PostgreSQL 18（本机无 PG，只在 PGlite PG18 跑）、CLI/MCP 端到端、production 短信与 Secure Cookie 运行时路径。
- **阶段 4 · M0 骨架（2026-11-04 完成）**：`apps/api`、`apps/web`、`packages/contracts|cli|mcp` 五包落地；契约注册表发射 OpenAPI 3.1（10 端点，handler 可 501）、CLI 命令树、MCP 工具表；迁移/审计 outbox/并发取号/权限判定内核 + PGlite(PG18) 用例；测试三件套（P0-1 底座自检、P0-2 口径锁定、workspace 门禁）与双平台 CI。**M1 已把原先 10 个 501 全部换成真实用例**。
- **阶段 4 交接（2026-11-03）**：9 个模块检查点已落 `docs/module-*.md`；开工顺序 platform →（masterdata ∥ inventory）→（purchase ∥ processing）→（sales ∥ internal-trade）→ settlement。
- **业务事实已收齐（2026-11-03）**：F1-F10 由负责人口述完毕，全部落 `docs/轻单_业务事实问答_v1_20261103.md`；由此派生的设计约束已收口进 `decisions.md` §5（行业中立、损耗报废无残值、保管人字段、客户退货两类型、内部交易=调货在途、打印无锚点 → 系统自设两套版式）。
- **决策已扩到 D50**：新增 D9 冲正单据（六类骨架）、D10 v1 降 L2、D11 客户在线支付 + 商户号模式 A、D12 到期处理、D13 不留密码、D14 手机号占用拒绝、D15 公司×岗位绑定、D16 编码固定结构、D17 行业中立、D18 单据链路视图、D19-D28（C 单生成时机 / 改价下限取数 / 取消级联 / 批次归属与跨司引用 / 微信授权收尾 / 收款台账位置 / 跨司链路 / 损失报表口径 / 损失可见性 / 含税口径）、D29-D34（N 单 C 单时机 / 错账路径不设调整单 J / 在途批次锁定 / 费用行跳过下限 / C 单损失净毛利展示 / 退款负数行记账）、D35-D39（C 单损失归属 / 重开提成 / 成本侧更正 / 库存可用量 / 费用行正负）、D40-D47（仅退款重算 / 待执行占用 / 成本更正审批 / 利润报表 / 功能域清单 / 集团看板一期不做 / 20 页重排 / 矩阵特殊值映射）、D48（个人编号 6 位全局唯一）、D49（业务档案编号边界：商品/客户/供应商/加工厂编号不定结构、不作检索主键）、D50（员工个人级权限覆盖：经理/老板给单员工增减权限、叠加岗位并集之上、经理不可改老板/财务/其他经理）。
- **二期评估备忘**：**调整单 J（红字冲销）**（D30）——一期错账用 R/收款记录/取消重开承接，成本侧录错锁定留日志；J 列为二期第一批评估项。
- **等材料 2 项**：① **M1**：一张真实订单的全链路数字（微信截图/口头报数均可），D5 公式验证的唯一材料；② **M2**：描述一次真实退货经过（F10b 改写，不阻塞第一批契约，第二批 N+提成冻结前给即可；2026-11-03 第四轮补登记，避免悬空）。原 M3「Excel 汇总表」经 F10 确认**不存在**，已作废。
- **等工程 1 项**：~~`prototype.html` 仍是旧 13 页 IA~~ **已重排**（2026-11-03 第六轮）：按 20 页新 IA（+利润报表/支付/打印）重做 `prototype.html` v1，待用户划改后定稿。
- **第二轮待拍项已全部清零（2026-11-03）**：F8 七套出厂岗位包、D4.1 改价规则（**下限内自由改、破下限需审批**，下限默认=成本价、租户可配）、D5③ 费用/商品分两子表+成本构成视图、D5④ 提成四条、G2 修订版（**全损耗路径**：可售量=0 时二次确认后提交，损失全额记 B 单、不生成产出批次）、G3（B 单必须有材料投入，=F2b）均已由负责人确认，详见 `decisions.md`。

## 下一步

1. ~~按 20 页新 IA 重排可点击原型~~ ✅ 已重排（`prototype.html` v1，待划改）。
2. ~~写字段级规格 + ER 图 → 接口契约两批冻结~~ ✅ 已冻结。
3. ~~模块切分 + 登记 + 生成检查点 + 迁文档入工程仓~~ ✅ 2026-11-03 完成（8 业务模块 + test；9 份产品文档 + raw 11 篇 + prototype.html 已迁入；归档仓冻结）。
4. ~~**P0 `platform` 开工前置**：出技术栈 ADR（后端/前端/数据库/多端收敛）→ 追加 `docs/decisions.md` D53~~ ✅ 2026-11-04 拍板 **D53 = ADR-0001 方案 A（TS 单一语言全栈）**；U1-U5 → **D55**、U12 spike → **D57**、Win10 兼容 → **D56**；契约第三批 → **D54 冻结**。**② M0 工程骨架 ✅ 2026-11-04 已建立**（`apps/api`、`apps/web`、`packages/contracts|cli|mcp` + 迁移 + 测试三件套 + CI）。**下一步 = M1**：登录/会话/Token/审计查询/权限覆盖，把 platform 的 501 逐个实现。
5. **各模块开工前置**：开发到某模块时先拍板其「开放项」（契约第一批 §11 / 第二批 §4），结果追加 `decisions.md` 并同步契约标记，再写代码。

## 已知问题 / 坑

- **原料缺口**：11 篇里 9 篇是飞书画板（`block_type=43`），`raw_content` 与 blocks API 都拿不到画板内容；用户 2026-11-03 决定不补。
- **权限矩阵读数已修正**（2026-11-03）：上一版按 7 岗位复原，整表错位一格，误判出「销售能编辑采购单」「销售能编辑商品成本」两处笔误。实际是 **8 岗位**（质检、理货各一列），老板=`全部`／经理=`管理` 贯穿，其余 6 岗位逐格。证据见 `prototype-v0.md` §3。**教训：拍平文本的列对齐不能靠"每行值个数"猜，要拿行内填充格数 + 第二来源交叉验证。**
- **迁移后不要再改归档仓**（2026-11-03）：`D:\Desktop\dsh\轻单` 已冻结只读，本仓 `docs/` 是唯一活跃副本；两边都改必然漂移。
- **术语**：正名「轻单」；飞书原文写「掌单」，原料区不改写，检索时两词都要搜。
- **本次会话曾偏离工作流**（2026-11-03 修正）：检查点全程缺失、cwd 长期停在 `D:\Desktop\dsh\Qingdan`、越界改了仓库外工具。前两项已修复，第三项见下节登记。

## 外部依赖（仓库外，改动必须在此登记）

| 文件 | 改动 | 为什么 | 回滚方式 |
|---|---|---|---|
| `C:\Users\32800\.claude\settings.json`（仓库外，Claude Code 配置） | **2026-11-04 新增 `permissions` 段**：`defaultMode: "acceptEdits"` + `allow: ["Bash","Edit","Write","Read","Glob","Grep","NotebookEdit"]`。改动前备份 `settings.json.bak-20261104` | 代码活按团队规则派给 Claude Code，但它的默认权限模式在本仓写文件会被拒（实测首轮派活一行代码都没落地） | 删掉 `permissions` 段即回滚；完整还原用 `Copy-Item settings.json.bak-20261104 settings.json -Force` |
| `D:\Desktop\dsh\daliy\feishu-wiki-export\feishu-wiki-export.cjs`（原始位置，仓库外、不在 git） | ① `docSourceUrl()` 增加 `node.nodeToken` 兜底，修真搬时 frontmatter `source` 恒为空；② 同空间同名文档写入时用 `node_token` 尾 8 位区分，修 11 篇落成 10 个文件的静默覆盖。改动日期 2026-11-03 | 不修则搬进来的原料违反「缺 source 视为不可追溯」，且会丢文档 | 手工把这两处改回原样即回滚；**回滚后重搬会复发这两个问题**。备份：同目录 `feishu-wiki-export.cjs.bak-20261103`（改动后的快照，防误删用，不是回滚点） |
| `tools\feishu-wiki-export.cjs`（仓库内受控副本，已纳入 git） | 与原始位置同一份内容（SHA-256 一致），已过 `--self-test` | 让搬运工具进版本控制，避免继续依赖仓库外、无备份的文件 | `git rm tools/feishu-wiki-export.cjs` 即可；之后回到原始位置运行 |
| `~/.dsh/AGENTS.md`（全局记忆，仓库外） | 2026-11-03 新增「会话总结格式」小节；同日追加「必须同时给一句话总结」（块外一行 + 可复制纯文本块） | 用户 2026-11-03 要求跨会话生效 | 删除该小节即回滚 |
| `~/.dsh/AGENTS.md`（全局记忆，仓库外） | **2026-11-04 新增「交互规则」小节**：① 收到用户消息先回「收到」再干活（本会话 + 之后群里新建的对话都生效）；② 每次回复的总结用大白话，术语顺带一句人话解释（**同日用户重申细化**：「收到」必须是第一句且立刻输出，不先思考、不先调工具） | 用户 2026-11-04 明确要求跨会话长期生效 | 删除该小节即回滚；不影响其他小节 |
| `~/.dsh/AGENTS.md`（全局记忆，仓库外） | **2026-11-04 重写「多智能体路由」节**：改为三套 harness 分工——DSH 中间人 / 代码活→Claude Code / 杂项→Codex；写明派发硬规则（任务自包含、写范围、180s 超时、只写不提交、验收看命令输出） | 负责人指令：重新搭建智能体团队，三套 harness 都接 DeepSeek | 恢复为 2026-11-03 版「多智能体路由」五条即回滚 |
| `C:\Users\32800\.codex\config.toml`（仓库外） | **2026-11-04 追加 `[projects.'d:\desktop\dsh\qingdan'] trust_level = "trusted"`**（只让 Codex 对本项目免信任询问，不动其他配置）；改动前备份 `config.toml.bak-20261104` | Codex 当「杂项手」要在本仓写文档/脚本，未信任目录会被拦 | 删掉这 3 行即回滚；完整还原用 `Copy-Item config.toml.bak-20261104 config.toml -Force` |
| `C:\Users\32800\.codex\config.toml`（仓库外） | **2026-11-04 追加 `[sandbox_workspace_write] network_access = true`**，让 Codex 沙箱能访问外网（复测 HTTP 200）。同日曾把 `web_search` 改成 `live` 验证，确认在 DeepSeek provider 下无效，已回退 `disabled`。备份：`config.toml.bak-20261104-network`、`config.toml.bak-20261104-search` | 负责人要求「要什么装什么」：Codex 当杂项手，调研类任务需要能上网 | 删掉这 3 行即回滚；完整还原用 `Copy-Item config.toml.bak-20261104-network config.toml -Force` |
| `~/.dsh/AGENTS.md`（全局记忆，仓库外） | **2026-11-04「交互规则」节追加「长等待必须先汇报」**（当日两次修订）：**不是不许等**，而是需要用户久等时先吭一声——单步预计 >15s 先说「等什么、多久、为什么」；能后台跑就后台跑，等待期间仍可对话；派外部 CLI 前说明「已派，约 20–45 秒」 | 负责人反馈回复间隔忽长忽短；并澄清「不是不给你睡，而是要我久等时要汇报」 | 删除该条即回滚 |
| `C:\Users\32800\.dsh\dsh-im-connect\ack-watcher.mjs`（仓库外，**已撤回**） | 2026-11-04 曾新增「收到」自动回执守望程序，同日**按负责人澄清撤回**：已杀进程、删 HKCU Run 项 `QingdanAckWatcher`、删除脚本。原因：负责人要的是「模型额度用光 → 收不到收到 → 去充钱」的存活信号，程序代发会让信号失效 | 撤回理由见左；「收到」必须由模型亲自发 | 已执行完毕，无残留（脚本与注册项均已删除） |

## 相关文件

- 项目规则：[AGENTS.md](../AGENTS.md)
- **已拍板口径总表（最常查）**：[docs/decisions.md](decisions.md)
- 决策日志（含讨论过程与被否方案）：[docs/轻单_阻塞问题决策清单_v1_20261103.md](轻单_阻塞问题决策清单_v1_20261103.md)
- 文档索引与模块表：[docs/README.md](README.md)
- 模块检查点（9 份）：[docs/module-platform.md](module-platform.md)、[module-masterdata.md](module-masterdata.md)、[module-inventory.md](module-inventory.md)、[module-purchase.md](module-purchase.md)、[module-processing.md](module-processing.md)、[module-sales.md](module-sales.md)、[module-internal-trade.md](module-internal-trade.md)、[module-settlement.md](module-settlement.md)、[module-test.md](module-test.md)
- 模块检查点模板：[docs/module-template.md](module-template.md)
- 项目上下文：[docs/project-context.md](project-context.md)
- 原型规格与待确认项：[docs/prototype-v0.md](prototype-v0.md)
- 可点击原型：[prototype.html](../prototype.html)
- 原料与搬运说明：[docs/raw-protocol.md](raw-protocol.md)
- 外部输入（仓库外，勿移动）：`D:\Desktop\workbuddy\2026-10-30-00-29-35\轻单_项目上下文说明_v1_20261103.md` —— 项目负责人 2026-11-03 提供的 AI 交接文档，含 8 岗位矩阵摘录、五类单据模型、术语表、P0/P1 待确认清单；本文件与它冲突时，先按它的信息优先级（L1 项目指令 > L2 当面确认 > L3 设计材料 > L4 实体草案）判断
- 测试入口：[tests/run.ps1](../tests/run.ps1)
- 仓库说明（clone 第一步）：[README.md](../README.md)
- hook 安装：[install-hooks.ps1](../install-hooks.ps1)；hook 源文件：[tools/pre-commit](../tools/pre-commit)
- 行尾规则：[.gitattributes](../.gitattributes)

## 变更记录

- **2026-11-04 M1 platform 核心可用（10 个端点全部去 501）**：负责人说「接手新一轮工作」后，按 `module-platform.md` 的 M1 范围（登录闭环 / 会话 / Token / 审计查询 / 权限覆盖写入）开工。**先拍技术裁定再写码**：`decisions.md` 新增 **D59** 八项（审计查询读路径＝属主视图 + 显式租户谓词；登录与凭证解析的跨 RLS 查找＝5 个 `SECURITY DEFINER` 函数；验证码＝非生产固定码、production 返 501；业务时区＝`Asia/Shanghai`；取号粒度与跳号沿用 N3①；`is_owner`＝`employee.is_owner` + 权限引擎短路；会话＝7 天滑动续期 + 5 分钟写入节流；CSRF＝同源 Origin/Referer 校验）。**实现**（派 Claude Code 分四批做，Lead 每批独立复跑验收）：`apps/api/migrations/0002_platform_m1.sql`（`audit_log_view`、`auth_find_login`、`auth_resolve_session`、`auth_resolve_api_token`、`audit_append_unscoped`、`api_token.version`/`employee.version`）、`apps/api/src/platform/auth/`（session-store / principal / plugin / cookie / tenant-context）、`apps/api/src/modules/platform/usecases/`（login / logout / me / api-tokens / audit-logs / permission-overrides）、`writer.ts` 新增 `recordAudit`。**实测纠偏**：`security_invoker` 视图在「基表不授 SELECT」前提下会 `permission denied`，改为属主视图 + 显式租户谓词（已回写 D59①）。**验证**：`pnpm -C apps/api test` 46 → **97 例全绿**；`pnpm -C apps/api exec tsc --noEmit` 退出码 0；全量 `pwsh -NoProfile -File tests\run.ps1` → `ALL PASSED (7 files)`、exit 0。**未验证**：真实 PostgreSQL 18（本机无 PG，只有 PGlite PG18）、CLI/MCP 端到端「登录→查看→写→审计落库」、production 短信与 `Secure` Cookie 的运行时路径、`apps/web` 登录页接线。
- **2026-11-04 M0 工程骨架建立（恢复开工）**：负责人指示「按检查点继续」后，从「搭骨架 + 补测试三件套」开工，落地 **pnpm monorepo 五包**：`apps/api`（Fastify 5 + Drizzle + PG18：`X-Request-Id`/UUIDv7 ALS、统一错误体、只从注册表生成路由、`0001_platform_core.sql` 13 表 + `qingdan_app` 普通角色 + 11 表 ENABLE/FORCE RLS + `audit_log` 只授 INSERT、审计 outbox 追加器、并发取号、权限判定一条 SQL）、`apps/web`（React 19 + Vite + Tailwind 4 + TanStack Router/Query，22 页路由壳，D56 基线 `chrome111/edge111`）、`packages/contracts`（22 功能域 × 8 动作词表、11 个封闭错误码、10 个平台端点注册表、OpenAPI 3.1 发射器、编号/取消级联/AI 边界口径）、`packages/cli`、`packages/mcp`（同源生成，危险动作默认拒绝）。**验证**：`pnpm -r build` 与 `pnpm -r test` 退出码 0（vitest 130 例：contracts 39 / api 43 / web 26 / cli 17 / mcp 5）；接口技术项补记为 **D58**（第 11 个错误码 `NOT_IMPLEMENTED`=501、新增 `X-Reason` 头）；`pwsh -NoProfile -File tests\run.ps1` → `ALL PASSED (7 files)`、exit 0；真实监听冒烟 `/api/v1/health` 200、`/api/v1/auth/me` 501 统一错误体、`/api/v1/nope` 404、CLI 走真实后端成功 0 / 失败 1。**测试三件套**：`tests/testbase.test.ps1`(P0-1)、`packages/contracts/src/spec-lock.test.ts` + `tests/platform-spec.test.ps1`(P0-2)、`tests/workspace.test.ps1`。**CI**：windows+ubuntu 加 Node 24/pnpm 11/`--frozen-lockfile`，新增 ubuntu + `postgres:18` 集成 job（`tests/db-concurrency.test.ps1` 未落地前按 `hashFiles` 守卫跳过）。**CI 已在真 runner 验证**：PR #1 三个 job 全绿——`test (windows-latest)` 1m31s、`test (ubuntu-latest)` 1m22s、`integration (ubuntu-latest, PostgreSQL 18)` 45s。**未验证**：本机未连真 PostgreSQL（迁移/审计/取号只在 PGlite PG18 跑过）、登录/Token/审计查询端点仍 501、4 位成员档案仍待本人确认（`docs/members/README.md` 状态 ⬜，不阻塞主线骨架）。
- **2026-11-04 开工前置规则落纸（成员档案）**：负责人要求「先确认身份再领任务」，且成员**必须自己落盘**自己的档案。新增 `docs/members/`：`README.md`（规则 + 现有成员表）、`_template.md`（档案模板）、四份待本人确认的档案（温汇敏 / 赖皓妍 / 李祖怡 / 梁海俊）。`TEAM-PLAN.md` 新增 **§0.2 开工前置**：确认身份 → 落盘档案 → 登记模块负责人 → 领任务 → 才动代码，明确「**档案没合并 = 没开工**」、禁止口头认领、禁止留空开工。`ONBOARDING.md` §0.1 同步加入该顺序，并顺手把环境里的 PostgreSQL 17 更正为 **18**（D57）。
- **2026-11-04 后端分工调整**：负责人确认**后端由「负责人 + 梁海俊」共同开发**（不是梁海俊一人扛）。梁海俊负责 `masterdata` / `inventory` / `processing` / `internal-trade` 的后端用例；负责人负责 `platform` 内核 / `purchase` / `sales` / `settlement` 并同在后端协作。协作规则同步写进 `docs/TEAM-PLAN.md` §0.1：接口与表结构先由主线出、两人共用同一份 `packages/contracts`、同一文件同时只有一人改、共用分支由负责人合并、提交前必须本地跑 `tests\run.ps1`。
- **2026-11-04 暂停开工，等人员到位**：负责人指示「先别干活，等分工好后、其他成员加入后再开始」。当前状态：**决策与前置全部收口**（D53 技术栈 / D54 契约第三批冻结 / D55 技术底座 / D56 Win10 兼容 / D57 spike 结论），U12 spike 已完成；**工程骨架 `apps/`、`packages/` 尚未创建，未写任何业务代码**。恢复开工的条件：4 位成员（温汇敏 / 赖皓妍 / 李祖怡 / 梁海俊）按 `docs/TEAM-PLAN.md` §0.1 认领到位后，从「搭骨架 + 补测试三件套」开始。
- **2026-11-04 U12 spike 完成（D57）**：实测三条技术命门 **9/9 通过**（脚本 `tools/spike-0001-pipeline.mjs`，报告 [spike-0001-tech-pipeline.md](spike-0001-tech-pipeline.md)）。Zod 4 → JSON Schema 2020-12 可用但**默认全内联**（`$ref`=0），契约注册表必须注册 id 再重写 `$defs`；PGlite 在 Windows 可跑，实测为 **PostgreSQL 18.6**（不是 17），故**生产库版本改为 PG 18**；**RLS 被 superuser 绕过**（即便 `force`），应用账号必须非 superuser/非 BYPASSRLS，否则 D55 的 RLS 兜底形同虚设。三条约束落 D57。
- **2026-11-04 分工二次确认（TEAM-PLAN §0.1 修订）**：负责人确认两点——① **`purchase`（A/S 单）移交主线**，梁海俊收缩为 `masterdata` + `inventory` + `processing` + `internal-trade` 的后端用例；② **权限域也交给温汇敏**（不只账号页面，含权限判定规则、三层生效、看价），主线仅保留审计写入、编号、单据框架、待办、API Token 与 `packages/contracts`。红线随之调整：温汇敏不得绕过 contracts 改契约，权限口径由主线提供 `tests/platform-spec.test.ps1` 锁死。
- **2026-11-04 四位人类成员到位（TEAM-PLAN §0.1）**：负责人给出姓名与自述职责——**温汇敏（账号管理）、赖皓妍（UI 界面设计优化）、李祖怡（单据）、梁海俊（其他）**。四人的自述职责是**功能性**划分，与 §0 的 M1-M4 模块划分不是同一维度，故新增 §0.1 映射表：温汇敏接 `platform` 的账号域（员工/岗位/权限设置/公司管理 + 登录与后台建号），赖皓妍接 `apps/web` 全部页面视觉与老浏览器适配（D56），李祖怡接八类单据的详情页/流转展示/打印版式，梁海俊接主数据 + 库存 + 三条业务线剩余后端用例；主线仍握 `platform` 内核、`packages/contracts`、`sales`、`settlement` 与测试底座。**待确认**：梁海俊「其他」的具体范围是否即表中承接项。
- **2026-11-04 技术底座与 Windows 10 兼容基线（D55/D56）**：负责人确认 ADR-0001 未决项 U1-U5 —— **D55**：共享库共享表 + `tenant_id` + 核心表 RLS（不做 schema/库隔离）、金额 `numeric(18,6)` 且聚合与毛利全程不舍入、主键 UUIDv7 应用侧生成、统一 Node 24 LTS + pnpm 11、审计写入失败即阻断业务（不接受「日志丢了数据改了」）。负责人另提出「租户电脑多数还是 Windows 10，技术栈别太新」，落 **D56**：问题不在技术栈新旧——后端/数据库/Node 全在我们云端，租户机器只跑浏览器；真正要锁的是**浏览器基线 = Win10 22H2 + Edge**（微软明确 Edge/WebView2 支持到 2028-10，无需 ESU，[官方页面](https://learn.microsoft.com/zh-cn/DeployEdge/microsoft-edge-supported-operating-systems)），前端锁 `browserslist` + Vite `build.target`（Chromium/Edge 111 级别）并进 CI，**不支持 IE11 与兼容模式**，Electron 仅 Win10 1809+/Win11；ADR 风险清单增 R11。**待确认**：租户是否仍有 IE11 / 兼容模式使用者。
- **2026-11-04 契约第三批冻结（D54）**：负责人逐条裁定契约第三批的 4 项开放项、10 处缺口与 5 个提问，结论追加 `decisions.md` **D54**，第三批状态 🟡 草案 → ✅ **已冻结**。要点：① 日志 `tenantId` 业务操作必填、平台级填目标租户、`system` 用固定字符串；② D51①② 落定（普通查询不记 / 敏感读必记 / 保留 180 天）；③ `dryRun` 预检要记日志但打标记；④ **一期不做短信发码与注册/入企端点**（产品未上线），账号由开发者后台或初始化脚本创建，上线前再补；⑤ **两个后台分层**——开发者后台（平台方，跨租户，`/api/v1/admin/**`，独立账号体系）≠ 老板/总部视图（客户老板在本租户内跨子公司，属 D15 既有能力）。同步：`module-platform.md` 开放项与验收第 1 条（登录闭环改为后台建号）、`tests/requirements.test.ps1` 断言由「草案」改「已冻结」、`adr-0001` 幂等冲突状态码 422→409。
- **2026-11-04 测试体检（qa-reviewer）**：全量 351 项断言全绿，但**业务规则断言 = 0**（全是文档存在性检查：把 D50/D21/D16 正文删成 TODO、公司码改成 3 位，测试仍全绿）。已排补测计划：P0-1 测试底座自检（`Exit-Test` + 全局 BOM）、P0-2 口径锁定（权限三层/编号/取消级联/审计 100%/AI 不可放大）、P0-3 用例库 fixtures。
- **2026-11-04 技术栈拍板（D53）**：负责人确认 **ADR-0001 方案 A：TypeScript 单一语言全栈**（Node 24 LTS + Fastify 5 + Drizzle + PostgreSQL 17 + React 19/Vite；`packages/contracts` 一套 Zod 注册表发射 OpenAPI 3.1 / CLI / MCP；审计事务内 outbox）。**多端互通口径写进决策**：业务与权限只在后端一处，Web/Electron/Capacitor 复用同一份前端，CLI 与 MCP 只是 `/api/v1` 的客户端。同步：`decisions.md` 追加 D53、ADR 状态转 ✅ 已接受、`AGENTS.md` 技术栈行、`module-platform.md` 开放项。顺带修文档瑕疵：`decisions.md` 两处空行截断表格（D51/D52/D52.1 与 D51①/D52①/D52② 曾脱离表格）、`module-platform.md` 模板残留 `${nl}` 与「追加 D51」笔误、`tools/pre-commit` 注释指向不存在的 `docs/raw/README.md`、`bootstrap.ps1` 与 `install-hooks.ps1` 补 BOM。
- **2026-11-04 测试体检（qa-reviewer）**：全量 351 项断言全绿，但**业务规则断言 = 0**（全是文档存在性检查：把 D50/D21/D16 正文删成 TODO、公司码改成 3 位，测试仍全绿）。已排补测计划：P0-1 测试底座自检（`Exit-Test` + 全局 BOM）、P0-2 口径锁定（权限三层/编号/取消级联/审计 100%/AI 不可放大）、P0-3 用例库 fixtures。

- **2026-11-04 模块划分定稿（5 个交付模块）**：主要负责人负责**主线**（`platform` + `sales` + `settlement`）；4 位人类开发者各负责 1 个交付模块——**M1** 主数据与采购（`masterdata`+`purchase`）、**M2** 库存与盘点（`inventory`）、**M3** 加工与损耗（`processing`）、**M4** 内部交易与打印（`internal-trade`+打印版式）；四模块以 PR **合并进主线**完善产品，合并前必过 CI + 共鸣测试 + 验收清单。同时 `ROLES-AND-BOUNDARIES.md` 新增 §10：建议其他成员搭同款智能体团队（附收益/风险与「采不采用自定」）。

- **2026-11-04 需求追加（D51/D52）**：负责人追加两条硬需求——① **平台、老板、员工、AI 的每一次操作都留日志**；② **应用完全支持 AI 操控**。落地：decisions 追加 D51（操作日志）/D52（AI 友好 API-first）；原型页面 20 → 22（+操作日志、+API 与集成）；新增 `docs/轻单_接口契约第三批_v1_20261104.md`（🟡 草案，含 4 项开放项，platform 开工前冻结）；`module-platform` 扩范围与验收；AGENTS 增加 API-first / 审计 / AI 同权约定；`tests/requirements.test.ps1` 断言第三批。

- **2026-11-03 阶段 4 交接（本仓首次提交）**：需求稿从归档仓迁入（decisions / 两份契约 / prototype-v0 / project-context / roadmap / 业务事实问答 / 阻塞问题决策清单 / raw-protocol + `raw/` 11 篇 + `prototype.html`）；模块切分为 8 业务模块 + `test`，登记 `AGENTS.md` 并各生成 `docs/module-*.md`（目标/范围/依赖/开放项/验收/进度）；新增 `tests/requirements.test.ps1` 锁迁移完整性；删除 calc 脚手架；归档仓冻结只读。
- **2026-11-03 第七轮 D50 定稿**：确认权限模型加「员工个人级」覆盖——经理/老板可对单个员工单独增减权限（可增可减，个人覆盖优先于岗位并集）；经理边界 = 不可改老板/财务/其他经理；权限设置页加「按员工单独配置」维度（员工下拉 + 勾选表格，与岗位基线差异项高亮）。同步 decisions/prototype-v0/README/roadmap 并改 `prototype.html`。
- **2026-11-03 第七轮权限表格优化**：确认「看价」是数据可见性开关、不属于「操作」，从权限设置表格（岗位/员工两个维度）的勾选列中移除——动作列由 8 列收敛为 7 列（查/建/编/审/出/删/导）；`price` 底层模型与 `canSeeMoney` 逻辑保留不动，仅表格不展示。同步 `decisions.md` D4「配置体验」补注。
- **2026-11-03 第七轮权限表格按能力显隐**：确认「功能域不支持的动作」不再摆空勾选框——新增 `DOMAIN_ACTIONS` 声明各域能力，表格里不具备的动作显示灰色「—」不可配置（表头仍统一 7 列对齐）。如库存流水/利润报表只读（仅查/导）、档案类无「审/出」、结算单无「建/出/删」等。同步 `decisions.md` D4「配置体验」补注。

- **2026-11-03 第六轮 D40-D47 定稿**：逐项确认契约收尾——仅退款分「纠收款/减成交额」两型（收口 D30③ 与 D40 矛盾）、待执行占用生命周期、成本更正审批人、利润报表与损失下钻、一期功能域清单、集团看板一期不做、20 页重排、矩阵特殊值映射；L4/L5/L10 关闭，遗留未决由 4 条收敛为 1 条（L9）。同步 decisions/prototype-v0/README/roadmap，并修正 `AGENTS.md` L9 工程仓说明。未动代码、未动 prototype.html。

- **2026-11-03** 负责人确认两个目录的角色与迁移时机：`轻单` = 需求稿真源（需求阶段所有结论只写这里），`D:\Desktop\dsh\Qingdan` = 工程仓（现故意留空，仅测试脚手架）；**需求定稿并通过测试后**一次性迁入，`轻单` 随后冻结只读。已写入「下一步」第 4 项与《第五轮裁定与修改工单》前置节。未动代码。

- **2026-11-03** 第五轮检查收尾：D35-D39 拍板并同步 decisions/prototype-v0/roadmap/README；修 README 与 roadmap 的版本滞后（更新至 D1-D39）；未动代码。

- **2026-11-03 第四轮检查收尾（D29-D34）**：交叉核对 decisions/prototype-v0/roadmap/README/project-context 五份文档，修复 2 处硬冲突（§4 状态机对齐 D21、D13/L11 对齐 D23）与 4 处文档滞后；6 处口径空洞由负责人逐条拍板——**D29** N 单单头已完成生成 C 草稿（与 E 同规则）；**D30** 一期不设调整单 J（错账走 R/收款记录/取消重开，成本侧录错锁定留日志，J 二期评估）；**D31** 在途批次可用量锁定、到货解锁转司；**D32** 下限校验仅商品行、费用行跳过；**D33** C 单详情加「本单相关损失 + 净毛利」只读块；**D34** 退款以负数行记入收款记录块。另在 D19 补「自动生成草稿不违反规则 #6」免责注。decisions/prototype-v0/README 同步。未动代码、未提交。

- **2026-11-03 第四轮契约口径确认（D19-D28）**：与负责人逐条确认 12 项——**D19** C 单生成时机（E 完成自动草稿 + 财务确认生效、一期一单一次结算）；**D20** 改价下限 = 行级加权平均批次成本、按行审批留痕、审批中行锁定；**D21** 取消级联（无下游可取消 + 同事务回滚、支持逆向解锁、已完成/已结算一律走冲正）；**D22** 批次归属（B/E 只引本公司批次、N 单签收才转司）；**D23** 微信授权一期不做、二期评估（收口 D13 残留，新增 L12 并关闭）；**D24** 收款台账内嵌 E 单详情页、不新增页面；**D25** 跨司链路只显节点不展开内容；**D26** 损失报表口径（覆盖 G2「报表二期定」：报表层「毛利 − 全损耗损失 = 净毛利」，C 单公式不动，记口径冲突 #10）；**D27** 损失金额受「看价格」权限管；**D28** 一期不管税。另确认：勾选矩阵等 L5 定稿一次性出（L4 备注）；M2 补登记进等材料清单。`prototype-v0.md`、`README.md` 同步更新。未动代码、未提交。

- **2026-11-03 第三轮跟进（D18 + 第二轮待拍项落文档）**：`decisions.md` D3 标注含冲正单据；`prototype-v0.md` 吸收 D18 单据链路视图（只读回溯、不参与成本归集）、D4.1 价格政策（默认售价带出、下限内自由改价、破下限审批）、G2 全损耗路径（可售量=0 二次确认、不生成产出批次、损失全额记 B 单且一期不进毛利）、F2b（B 单必须有材料投入）、F8 七套出厂岗位包，并在数据模型新增「损失记录」实体；`docs/README.md` 同步 prototype 状态为 D1-D18。

- **2026-11-03 第二轮待拍项清零 + D18**：负责人确认 6 项——F8 七套出厂岗位包（老板免配/销售/销售+仓管/财务+销售/纯仓管/采购/经理）、D4.1 改价规则（下限内自由改、破下限需审批，下限默认=成本价租户可配）、D5③ 费用/商品分两子表+成本构成视图（A 单成本提交即锁批次价）、D5④ 提成四条（按人/岗、改比例不重算、负毛利记 0、E→N 归 E 单负责人）、G2 修订版（全损耗路径：可售量=0 二次确认后提交，损失全额记 B 单留痕、不生成产出批次）、G3=F2b（B 单必须有材料投入）。新增 **D18 单据链路视图**（批次自动串联 + 链路一键回溯 + B 单可选关联销售单，只读、成本归集不依赖）。`decisions.md` D4.1/F8/G2/F2b 改 ✅、§1 补 D18；遗留未决由 7 条收敛为 4 条（L4/L5/L9/L10）。

- **2026-11-03 新一轮规划跟进（F 类事实 + D9-D17）**：`docs/README.md` 索引新增（新会话先读）；`轻单_业务事实问答_v1_20261103.md` F1-F10 收齐；`decisions.md` 修正 D2（六类标注）、D4 退货（改多岗可录，F4）、补 D17 行业中立、新增 §5「由业务事实派生的设计约束」17 条、关闭 L8/L11、补口径冲突 7-9 三条（含「订阅费在线支付 vs 货款在线支付」的措辞区分）；`project-context.md` 补行业定位与六类骨架；`prototype-v0.md` 补冲正单据 R/S/I、客户支付、两套打印版式、保管人、编码规则、公司×岗位绑定、出厂组合包、第 10 行改为 `否`。

- **2026-11-03 决策收口（D1-D8 落地）**：新建 `docs/decisions.md`（已拍板 9 组 / 待确认 4 项 / 遗留 11 条 / 口径冲突 5 条）；`project-context.md` §1 定位收紧为「成本核算+进销存 SaaS」、§2 权限模型升级为预设岗位+自定义岗位、§3 业务域扩为五类骨架、§6 部署改为云 SaaS 单一形态+本地只读备份、§8 未知刷新为 5 条（1/2 已解、3 仍未定）、§9 删除「不做多租户 SaaS」并标作废；`prototype-v0.md` 全篇按拍板重排（IA 5→6 块、页面 13→19 页+1 项全局能力、矩阵降级为出厂预设、数据模型加租户/公司/批次/费用子表/待办/流转表、状态机改单头三态+行状态、§6 标注旧原型已过期）；`roadmap.md` 按 D0 修正阶段表述。

- **2026-11-03 权限矩阵复原（产品决策第 3 件）**：改为 8 岗位 × 11 行，撤销上一版两处「笔误」判断（证据：原文权限设置行 8 个填充格 + v1 文档 §7.5 六行逐字一致）；`prototype-v0.md` §3 重写并新增 §3.1 逐行复核表、§3.2 整表级未定；`project-context.md` §2/§8 角色数与矩阵状态同步修正；`roadmap.md` 记录该修正与教训。

- **2026-11-03 工程链路闭环**：hook 源文件 `tools/pre-commit` 入库（`.gitattributes` 钉 LF、`git update-index --chmod=+x`）；新增 `install-hooks.ps1`（安装 + 哈希自检 + 跑全量测试）；新增仓库根 `README.md`（clone 第一步 / 常用命令 / 目录 / 阶段）；`AGENTS.md`「测试」节写明新环境必须先装 hook；`tests/roadmap.test.ps1` 增加第 10 段断言（源文件存在、安装脚本存在、`.gitattributes` 声明 LF、源与已装版本哈希一致）。
- **2026-11-03 待裁决三项落地**：① 外部工具两处 bug 保留不回滚，补登记 + 同目录 `.bak-20261103` 快照 + 纳入 `tools/`；`AGENTS.md` 增加「仓库外改动必须先征询并登记，否则视为违规」硬规则。② `docs/raw/README.md` → `docs/raw-protocol.md`，`docs/raw/` 只留原文，并加测试断言。③ 提交一次以验证 hook 真实链路。
- **2026-11-03 工作流初始化收口**：新增 `tests\roadmap.test.ps1`（检查点/阶段/外部依赖的契约测试，23 项断言）；`pre-commit` 做出通过、拦住失败两种验证；`docs/prototype-v0.md` 里的原型路径同步改为 `prototype.html`。
- **2026-11-03 初始化**：会话 cwd 从 `Qingdan` 切到 `轻单`；`prototype/index.html` 上移为根目录 `prototype.html`（不为单文件保留目录）；新建本文件作为阶段检查点；`AGENTS.md` 增补「阶段与检查点」与「外部依赖登记」规则。
- **2026-11-03**：阶段 1 原料搬运完成（11 篇）；阶段 2 上下文与原型规格完成；阶段 3 原型 v0 交付。
