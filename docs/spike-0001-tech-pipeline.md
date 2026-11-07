# Spike-0001 · 技术管线实测（U12）

| 项 | 内容 |
|---|---|
| 状态 | ✅ **通过（9/9），但有 3 条工程约束需固化**（见 §4，已落 `docs/decisions.md` D57） |
| 日期 | 2026-11-04 |
| 执行 | Lead（DSH 智能体团队主线） |
| 目的 | 验证 ADR-0001 U12 指出的三条技术命门：① Zod 4 → JSON Schema 2020-12 → OpenAPI 3.1；② PGlite（WASM PG）能否在 Windows 跑；③ Fastify 5 + Drizzle 组合 |
| 脚本 | [`tools/spike-0001-pipeline.mjs`](../tools/spike-0001-pipeline.mjs)（可复跑，见 §2） |
| 关联 | D53（技术栈）/ D55（技术底座）/ ADR-0001 U12 / R4（PGlite 与真 PG 语义差异） |

## 1. 实测结果（原样输出）

```
PASS  Zod4 z.toJSONSchema 可用  ->  https://json-schema.org/draft/2020-12/schema
PASS  JSON Schema 为 2020-12 方言（OpenAPI 3.1 要求的方言）  ->  https://json-schema.org/draft/2020-12/schema
PASS  $defs 引用需重写为 #/components/schemas（关键工程发现）  ->  {"refCount":0,"sample":"(全部内联)","mustRewrite":false}
PASS  PGlite 启动（WASM Postgres，Windows）  ->  PostgreSQL 18.6 (PGlite 0.5.15) on wasm32-unk
PASS  numeric(18,6) 读出为字符串（合契约金额传字符串）  ->  {"amount":"1234.567890","jsType":"string"}
PASS  RLS 生效（需以非超级用户身份连接；superuser 会绕过 RLS）  ->  tenant=A 只看到 1 行（superuser 身份则绕过，见备注）
PASS  UUIDv7 生成且时间有序  ->  01a1a49f-0cea-743d-b357-95e5fd1340ac
PASS  Drizzle(pglite) 查询可用  ->  rows=[{"c":2}]
PASS  Fastify 5 起服务 + Zod 校验 + 422 返回  ->  health=200 bad=422 good=201

RESULT: 9/9 passed
versions: node=v24.22.0 zod=4.6.7 fastify=5.12.8
```

环境：Windows 10/11 本机，Node **24.22.0**（`%LOCALAPPDATA%\nvm\v24.22.0`，非 PATH 上的 18.20.8），pnpm 10.33 在 PATH，npm registry 可达（HTTP 200）。
依赖版本：`zod@4.6.7`、`fastify@5.12.8`、`drizzle-orm@0.45.4`、`@electric-sql/pglite@0.5.15`、`uuid@14.0.3`。

## 2. 如何复跑

```powershell
$d="$env:TEMP\qingdan-spike"; New-Item -ItemType Directory -Force $d | Out-Null; cd $d
& "$env:LOCALAPPDATA\nvm\v24.22.0\npm.cmd" init -y
npm install zod fastify drizzle-orm @electric-sql/pglite uuid
Copy-Item "D:\Desktop\dsh\Qingdan\tools\spike-0001-pipeline.mjs" "$d\spike.mjs"
& "$env:LOCALAPPDATA\nvm\v24.22.0\node.exe" "$d\spike.mjs"
```

预期末行 `RESULT: 9/9 passed`，退出码 0。

## 3. 关键发现（三条命门逐条）

### 3.1 Zod 4 → OpenAPI 3.1：可用，但「去重注册」要自己做

- `z.toJSONSchema(schema, { target: 'draft-2020-12' })` **直接可用**，输出 `$schema = https://json-schema.org/draft/2020-12/schema`，正是 OpenAPI 3.1 的方言。
- **但默认行为是全部内联**：本次用例的 `Order` 里嵌 `Line`，导出结果是 `refCount = 0`（`Line` 被展开写在 `Order` 里，没有 `$defs`/`$ref`）。
- 后果：直接把 Zod 输出塞进 `components.schemas` 会得到**一个大块内联 schema**，同一实体在多个端点出现时重复膨胀，且无法被 `$ref` 复用。
- **工程结论**：契约注册表必须用 Zod 的全局注册表（`z.globalRegistry.add(schema, { id: 'Order' })`）给每个实体注册 id，导出后**把 `$defs/<id>` 的 `$ref` 重写为 `#/components/schemas/<id>`**，并在 CI 里断言「`components.schemas` 里的实体数 = 注册表实体数」。

### 3.2 PGlite：Windows 上跑得通，但**是 PG 18.6，不是 17**

- `select version()` → **PostgreSQL 18.6 (PGlite 0.5.15) on wasm32-unknown`**。
- `numeric(18,6)` 插入 `1234.567890`，读回 **字符串 `"1234.567890"`**（`typeof === 'string'`）——与契约「金额用 decimal 字符串传输」天然吻合，无需额外转换。
- 版本错配是真问题：ADR/D55 写的生产库是 **PostgreSQL 17**，而本地 L2 测试跑的是 **18**（R4 风险的具体形态）。

### 3.3 RLS：**机制可用，但超级用户会直接绕过（含 FORCE）**

- 第一次实测 `enable row level security` + `force row level security` + policy，`tenant=A` 仍然看到 **2 行**。
- 原因：PGlite 默认连接是 **superuser**，PostgreSQL 的 superuser 与 `BYPASSRLS` 角色**不受 RLS 约束**，`FORCE ROW LEVEL SECURITY` 只影响表 owner，不影响 superuser。
- 改法：`create role app_user nologin` → `grant` → `set role app_user` → 再查，**只看到 1 行，RLS 正常**。
- **工程结论（这条最要命）**：D55 的「核心表 RLS 兜底」只有在**应用连接账号不是 superuser、且没有 BYPASSRLS** 时才成立。生产与测试都必须用专用角色，否则 RLS 是装饰品，跨租户泄漏照旧。

### 3.4 其余

- **UUIDv7**：`uuid@14` 的 `v7()` 可用，连续两次生成满足字符串序 = 时间序。
- **Drizzle + PGlite**：`drizzle(pg)` + `db.execute(sql\`...\`)` 正常，`rows` 结构符合预期。
- **Fastify 5**：`app.inject()` 免端口测试可用；Zod `safeParse` 失败自行回 `422` 正常；无需额外校验插件（`fastify-type-provider-zod` 非必需，但接入可减少样板）。

## 4. 由本次实测产生的工程约束（已落 D57）

1. **契约注册表必须给每个实体注册 id**，导出后重写 `$defs → components.schemas`，CI 断言实体数量一致（3.1）。
2. **数据库版本对齐**：生产 PostgreSQL 与测试用 PGlite 的**主版本一致**。鉴于 PGlite 已是 18.6，建议生产也用 **PG 18**（替代 ADR 原写的 17），避免「测试环境与生产环境主版本不同」这一类最难查的 bug。
3. **数据库账号权限**：应用连接账号**不得是 superuser、不得有 BYPASSRLS**，RLS 才生效；测试里用 `set role` 模拟（3.3）。

## 5. 未验证 / 不在本 spike 范围

- 真实 PostgreSQL 实例（17 或 18）上的同样用例未跑，本 spike 只在 WASM 版 PG 上验证。
- 并发与锁（`FOR UPDATE` / 行锁争用 / 取号 20 并发）未测——属 L3 真库任务，必须进 CI。
- Zod 注册表 → OpenAPI 完整生成器（含 `$ref` 重写、tag、`x-audit`/`x-scope` 扩展）未实现，仅验证底层能力。
- 打包体积、启动时间、`distroless` 容器构建未涉及。
- PGlite 0.5.15 的 PG 18 与生产 PG 18 在**扩展**（如 `pgcrypto`）上的差异未测。
