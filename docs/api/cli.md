# 轻单 CLI 命令表（`qingdan`）

> **状态：草案（0.1.0-draft）**，与 `docs/api/openapi.yaml` 同批。契约真源见
> `docs/轻单_接口契约第三批_v1_20261104.md` §4（CLI 与 MCP 映射）与 §3（通用 API 约定）；
> 命令对应的 REST 端点以 `docs/api/openapi.yaml` 为准。

## 0. 定位与铁律

CLI 是**薄客户端**：每个动作一对一映射一个 REST 端点，**不得绕过服务端权限与审计**（契约第三批 §4）。
同一动作在 Web / CLI / MCP 三种入口的**行为、错误码、操作日志字段必须一致**（契约第三批 §4）。

- CLI 产生的操作日志：`source = cli`（来源枚举见契约第三批 §1）。
- 鉴权：优先 `--token`（`Authorization: Bearer <token>`，AI / 机器身份）；
  否则使用登录时保存的会话 Cookie（人类身份）。
- 每个请求自动带 `X-Request-Id`（UUID v4，可复现时允许覆盖），响应头回写的值用于对账。
- 写命令自动生成 `Idempotency-Key`（可用 `--idempotency-key` 覆盖），24h 内重复提交返回首次结果。
- 写命令默认先走一次 `dryRun=true` 预检？**不**——`--dry-run` 由用户显式选择；
  危险动作（`--reason` 必填类）在非交互环境必须显式 `--yes`（见 §2）。

## 1. 全局参数

| 参数 | 取值 | 作用 | 默认 |
|---|---|---|---|
| `--json` | flag | 输出服务端原始 JSON（不包裹、不美化摘要）；错误时向 stderr 输出统一错误体 | 人类可读表格 |
| `--dry-run` | flag | 写命令发 `dryRun=true`，只校验不落库，输出 `DryRunResult` | 关 |
| `--reason "..."` | string | 危险动作 / AI 写操作的意图说明，进操作日志（契约第三批 §1「原因」） | 无；缺失则本地报用法错误 |
| `--yes` | flag | 跳过危险动作的交互式二次确认（非 TTY 环境**必须**给） | 交互确认 |
| `--api-url <url>` | URL | API 基地址，覆盖环境变量 | `QINGDAN_API_URL`，否则 `http://127.0.0.1:8080/api/v1`（部署端口待 ADR） |
| `--token <token>` | string | API Token（Bearer），覆盖环境变量与本地会话 | `QINGDAN_TOKEN`，否则本地会话 Cookie |

其他约定（实现层，不属于契约）：

- `--help` / `--version` 不产生 API 请求、不记日志。
- 登录成功后会话凭证存本地配置目录（权限 0600）；`qingdan auth logout` 清除。
- 所有命令支持 `--format table|json` 之外的输出在本文档不承诺，`--json` 是唯一稳定机器接口。
- 写命令额外支持 `--idempotency-key <key>`（幂等键覆盖，便于重试编排）。

## 2. 退出码

契约第三批 §4 冻结的 5 个退出码：

| 退出码 | 含义 | 触发场景（HTTP / 错误码） |
|---|---|---|
| `0` | 成功 | 2xx；`dryRun` 且 `valid=true` |
| `2` | 用法错误 | 未知命令 / 参数缺失或非法 / 危险动作缺 `--reason` / 非 TTY 缺 `--yes`（**未发请求**） |
| `3` | 无权限 | HTTP 401、403（含 scope 不足、公司数据隔离、AI 危险动作 `AI_ACTION_FORBIDDEN`） |
| `4` | 校验失败 | HTTP 422 `VALIDATION_FAILED`；`dryRun` 且 `valid=false`；HTTP 404、428（**提案，见 §8**） |
| `5` | 并发冲突 | HTTP 409 `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` |

契约未定义的兜底：网络错误、5xx、HTTP 429 限流等，CLI 以 `1` 退出并在 stderr 说明
（`1` 不在契约 0/2/3/4/5 内，是提案，见 §8「未决项」）。

### 2.1 错误体示例

服务端统一错误体（契约第三批 §3），CLI 在 `--json` 下原样输出到 stderr：

```json
{
  "code": "AI_ACTION_FORBIDDEN",
  "message": "危险动作默认禁止 AI 执行（D52①）",
  "details": {
    "action": "sales.complete",
    "policy": "forbidden-by-default"
  },
  "requestId": "req_01J0EXAMPLE000000000000002"
}
```

并发冲突示例（退出码 `5`）：

```json
{
  "code": "VERSION_CONFLICT",
  "message": "单据已被他人修改，请刷新后重试",
  "details": { "expectedVersion": 3, "currentVersion": 4 },
  "requestId": "req_01J0EXAMPLE000000000000004"
}
```

非 `--json` 模式下的人类可读形式（示例）：

```text
$ qingdan sales complete 3f2b... --reason "客户已提货，完成开票流程"
✗ 403 AI_ACTION_FORBIDDEN：危险动作默认禁止 AI 执行（D52①）
  所需 scope：sales.approve　请求 id：req_01J0EXAMPLE000000000000002
```

## 3. 命令语法与 scope 约定

```text
qingdan <domain> <action> [参数] [全局参数]
```

**scope 语法**：`<功能域>.<动作>`，动作可重复（`--scope sales.read --scope sales.create`），
也可逗号分隔（`--scope sales.read,sales.create`）。功能域与 `docs/api/openapi.yaml` 的 tag 一致；
8 动作映射（契约第一批 §1.2）：

| 契约中文动作 | scope 动作（英文，骨架拟定） |
|---|---|
| 查 | `read` |
| 建 | `create` |
| 编 | `update` |
| 审 | `approve` |
| 出库 | `ship` |
| 删 | `delete` |
| 看价 | `view_price` |
| 导出 | `export` |

## 4. 命令表（23 个动作）

> 「REST」列为 `docs/api/openapi.yaml` 的 `operationId`；「reason」列 `必填` = 契约要求的原因字段
> （危险动作 / AI 写操作）；「AI」列 `403` = 危险动作默认禁止 AI（D52①）。

### 4.1 auth（登录与会话）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan auth login --phone <手机号> --code <验证码>` | 登录，保存会话 Cookie | `login` | 无（`security: []`） | — | 不适用 |
| `qingdan auth logout` | 登出，清除本地会话 | `logout` | 无（会话本身） | — | 不适用 |
| `qingdan auth whoami` | 当前身份 + 生效权限（服务端实时计算） | `getCurrentIdentity` | 无 | — | 允许 |

### 4.2 purchase（A 采购单）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan purchase list [--status 进行中] [--supplier <id>] [--from <t>] [--to <t>] [--limit 50] [--cursor ...]` | 采购单列表 | `listPurchaseOrders` | `purchase.read` | — | 允许 |
| `qingdan purchase get <id>` | 采购单详情 | `getPurchaseOrder` | `purchase.read` | — | 允许 |
| `qingdan purchase create --file <payload.json>` | 新建采购单（--dry-run 预检） | `createPurchaseOrder` | `purchase.create` | 条件必填（AI 写） | 允许 |

`purchase create` 的 payload 对应 `PurchaseOrderCreateRequest`：
`supplierId`、`handlerId`、`lines[]`、`feeLines[]`（A 单金额可负，负数必须 `note`，D39）、`companyId?`、`reason?`。

### 4.3 sales（E 销售单与收款）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan sales list [--status 进行中] [--customer <id>] [--handler <id>] [--from] [--to]` | 销售单列表 | `listSalesOrders` | `sales.read` | — | 允许 |
| `qingdan sales get <id>` | 销售单详情（含收款记录块） | `getSalesOrder` | `sales.read` | — | 允许 |
| `qingdan sales create --file <payload.json>` | 新建销售单（--dry-run 预检） | `createSalesOrder` | `sales.create` | 条件必填（AI 写） | 允许 |
| `qingdan sales complete <id> --reason "..."` | 完成 E 单，自动生成 C 单草稿 | `completeSalesOrder` | `sales.approve` | **必填** | **403** |
| `qingdan sales receipt <id> --file <receipt.json>` | 追加收款记录（退款为负数行） | `addSalesReceipt` | `sales.update` | 退款方向必填 | 退款方向按冲正口径 403 |

`sales complete` 要求 `If-Match`：CLI 先用 `sales get` 取 `version` / `ETag`，或用 `--if-match <version>` 显式传入；
版本冲突退出码 `5`。确认语句提示「完成后自动生成 C 单草稿，一期一单一次结算（D19）」。

### 4.4 settlement（C 结算单）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan settlement list [--status 待确认] [--source-type E]` | 结算单列表 | `listSettlementOrders` | `settlement.read` | — | 允许 |
| `qingdan settlement confirm <id> --reason "..."` | 结算确认（草稿 → 已结算，不可冲正） | `confirmSettlementOrder` | `settlement.approve` | **必填** | **403** |

`settlement confirm` 需 `If-Match`（同 `--if-match` 约定），AI 不得审批自己发起的动作（D52.1③）。

### 4.5 batch / inventory（批次与库存）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan batch list [--product <id>] [--company <id>] [--available-only]` | 批次列表（含可用量） | `listBatches` | `inventory.read` | — | 允许 |
| `qingdan batch get <id>` | 批次详情 | `getBatch` | `inventory.read` | — | 允许 |
| `qingdan inventory list [--batch <id>] [--source-order <id>] [--from] [--to]` | 库存流水（只追加） | `listInventoryTransactions` | `inventory.read` | — | 允许 |

### 4.6 permission（员工与权限）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan permission employee list [--company <id>]` | 员工列表（含公司-岗位与个人覆盖） | `listEmployees` | `platform.read` | — | 允许 |
| `qingdan permission set <employeeId> --file <permissions.json> --reason "..."` | 修改员工权限（岗位并集 ⊕ 个人覆盖） | `updateEmployeePermissions` | `platform.update` | **必填** | **403** |

### 4.7 token（API Token）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan token list [--status active] [--employee <id>]` | Token 列表（永不含明文） | `listApiTokens` | `platform.read` | — | 允许 |
| `qingdan token create --name "..." --employee <id> --scope sales.read [--expires-at <t>] [--ip-allowlist <cidr,...>]` | 创建 Token（明文只打印一次） | `createApiToken` | `platform.create` | 条件必填（AI 调用） | 允许，但 scope ⊆ 创建人授权（D52.1①） |
| `qingdan token revoke <id> --reason "..."` | 撤销 Token（立即失效） | `revokeApiToken` | `platform.delete` | **必填** | **403** |

`token create` 的 scope 超出创建人自身授权时服务端直接拒绝（422，D52.1①）；CLI 不做本地兜底。

### 4.8 audit / meta（日志与接口真源）

| 命令 | 作用 | REST | scope | reason | AI |
|---|---|---|---|---|---|
| `qingdan audit list [--actor-type ai] [--source cli] [--action sales.create] [--result fail] [--from <t>] [--to <t>] [--limit 50] [--cursor ...]` | 查询操作日志（只读、只追加） | `listAuditLogs` | `platform.read` | — | 允许（查看日志本身也记日志） |
| `qingdan api openapi [--out openapi.json]` | 拉取 `GET /api/v1/openapi.json`（接口真源） | `getOpenApiDocument` | 按服务端 | — | 允许 |

### 4.9 命令示例

```bash
# 预检一个采购单（不落库）
qingdan purchase create --file a-order.json --dry-run --json

# 完成销售单（危险动作：reason 必填；AI token 会被 403）
qingdan sales complete 0f3c2a1e-... --reason "客户自提完成，按 D19 生成结算草稿"

# 创建只读 Token：scope 只能从创建人自己的授权里选
qingdan token create --name "report-agent" --employee 8a1b... \
  --scope sales.read --scope inventory.read --json
```

## 5. CLI ↔ MCP 对照表

契约第三批 §4：MCP 每个工具与一个 REST 接口一对一；工具描述里声明所需 scope 与是否需要
`reason` / 审批；Agent 通过 MCP 看到的权限与 Web 完全一致。

MCP 工具命名约定（提案）：`qingdan_<domain>_<action>`，与 `operationId` 一一对应。

| CLI 命令 | REST operationId | MCP 工具（提案） | scope | reason | 审批 / AI |
|---|---|---|---|---|---|
| `qingdan auth login` | `login` | 不暴露为 MCP 工具 | — | — | 人类登录，AI 不用 |
| `qingdan auth logout` | `logout` | 不暴露为 MCP 工具 | — | — | 人类会话 |
| `qingdan auth whoami` | `getCurrentIdentity` | `qingdan_auth_whoami` | — | — | 允许 |
| `qingdan purchase list` | `listPurchaseOrders` | `qingdan_purchase_list` | `purchase.read` | — | 允许 |
| `qingdan purchase get` | `getPurchaseOrder` | `qingdan_purchase_get` | `purchase.read` | — | 允许 |
| `qingdan purchase create` | `createPurchaseOrder` | `qingdan_purchase_create` | `purchase.create` | AI 必填 | 允许 |
| `qingdan sales list` | `listSalesOrders` | `qingdan_sales_list` | `sales.read` | — | 允许 |
| `qingdan sales get` | `getSalesOrder` | `qingdan_sales_get` | `sales.read` | — | 允许 |
| `qingdan sales create` | `createSalesOrder` | `qingdan_sales_create` | `sales.create` | AI 必填 | 允许 |
| `qingdan sales complete` | `completeSalesOrder` | `qingdan_sales_complete` | `sales.approve` | **必填** | 人类审批；AI 默认 403 |
| `qingdan sales receipt` | `addSalesReceipt` | `qingdan_sales_add_receipt` | `sales.update` | 退款必填 | 退款按冲正口径 403 |
| `qingdan settlement list` | `listSettlementOrders` | `qingdan_settlement_list` | `settlement.read` | — | 允许 |
| `qingdan settlement confirm` | `confirmSettlementOrder` | `qingdan_settlement_confirm` | `settlement.approve` | **必填** | 人类审批；AI 默认 403 |
| `qingdan batch list` | `listBatches` | `qingdan_batch_list` | `inventory.read` | — | 允许 |
| `qingdan batch get` | `getBatch` | `qingdan_batch_get` | `inventory.read` | — | 允许 |
| `qingdan inventory list` | `listInventoryTransactions` | `qingdan_inventory_list` | `inventory.read` | — | 允许 |
| `qingdan permission employee list` | `listEmployees` | `qingdan_permission_employee_list` | `platform.read` | — | 允许 |
| `qingdan permission set` | `updateEmployeePermissions` | `qingdan_permission_set` | `platform.update` | **必填** | 人类审批；AI 默认 403 |
| `qingdan token list` | `listApiTokens` | `qingdan_token_list` | `platform.read` | — | 允许 |
| `qingdan token create` | `createApiToken` | `qingdan_token_create` | `platform.create` | AI 必填 | 允许（scope ⊆ 创建人授权） |
| `qingdan token revoke` | `revokeApiToken` | `qingdan_token_revoke` | `platform.delete` | **必填** | 人类审批；AI 默认 403 |
| `qingdan audit list` | `listAuditLogs` | `qingdan_audit_list` | `platform.read` | — | 允许（记读日志） |
| `qingdan api openapi` | `getOpenApiDocument` | `qingdan_meta_openapi` | — | — | 允许 |

## 6. `--dry-run` 语义

对写命令（`purchase create`、`sales create`、`sales complete`、`sales receipt`、`settlement confirm`、
`permission set`、`token create`、`token revoke`）：

1. CLI 在请求上加 `dryRun=true`；
2. 服务端只校验不落库，返回 `DryRunResult`（`docs/api/openapi.yaml#/components/schemas/DryRunResult`）；
3. `valid=true` → 打印将要发生的变更，退出码 `0`；
4. `valid=false` → 打印 `errors[]`，退出码 `4`；
5. dryRun **是否也落审计日志** 契约未规定（见 §8）。

## 7. `--reason` 与 `--yes` 语义

- `--reason`：危险动作（删除 / 冲正 / 成本更正 / 结算确认 / 权限变更）与 **AI 写操作**必填
  （契约第三批 §1「原因」）。CLI 在发请求前校验：缺失 → 退出码 `2`，不发请求。
- `--yes`：危险动作的交互确认；非 TTY（脚本、CI、AI 调用）必须显式给 `--yes`，否则退出码 `2`。
  交互确认文案必须写明「危险动作」与「是否记审计日志」。
- 拒绝确认 → 退出码 `2`，不发请求、不记日志。

## 8. 与契约的缺口 / 未决项（需 platform 冻结时拍板）

| # | 项 | 本文件的做法 | 待确认 |
|---|---|---|---|
| 1 | 契约只规定 0/2/3/4/5 退出码，未规定 429 限流、网络错误、5xx 的退出码 | 统一用 `1`（未分类失败）兜底 | 是否新增 `6`（限流）/ `7`（网络）等 |
| 2 | 契约未规定 404 与 428 的退出码映射 | 归入 `4`（校验失败） | 是否单独给码 |
| 3 | CLI 与 Web/MCP 的「来源」如何判定（审计 `source = cli`） | 建议 CLI 发 `X-Client: cli` 扩展头，服务端据此写 `source` | 契约 §1 定义了枚举但未规定判定方式 |
| 4 | 默认 API 地址 | `http://127.0.0.1:8080/api/v1` | 部署端口/域名待技术栈 ADR（D53） |
| 5 | MCP 工具命名只给「与 REST 一对一」，未给命名规则 | 提案 `qingdan_<domain>_<action>` | 是否用 operationId 直译 |
| 6 | scope 的英文动作名（read/create/…）契约只给中文动作名 | 按 8 动作拟定英文映射 | 是否冻结该英文映射 |
| 7 | `qingdan api openapi` 是否需要认证 | 默认走全局认证 | 是否公开 |
| 8 | `dryRun` 是否落审计日志 | 未假定 | 契约 §3 只说「只校验不落库」 |

## 9. 相关文件

- OpenAPI 骨架：[`docs/api/openapi.yaml`](openapi.yaml)
- 契约第三批：[`docs/轻单_接口契约第三批_v1_20261104.md`](../轻单_接口契约第三批_v1_20261104.md)
- 契约第一批：[`docs/轻单_接口契约第一批_v1_20261103.md`](../轻单_接口契约第一批_v1_20261103.md)
- 口径真源：[`docs/decisions.md`](../decisions.md)（D51 / D52 / D52.1）
