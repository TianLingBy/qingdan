# #162 交接单：补 `StockFlowPort.createBatch` 与批次取号

> 领取人：温汇敏（GitHub `2696708617-web`）　派单人：负责人（`TianLingBy`）　2026-11-10
> 上游：issue #162（Vince-Leong 2026-11-10 04:41 第三次催办，`8416a33` 上 `StockFlowPort` 仍只有 `applyAdjustment`）
> 下游：issue #137（梁海俊实现 A 单入库时要用这个端口）

## 一、为什么要做

A 采购单入库要「开一个批次 + 拿一个批次号 + 锁成本」，但现在 `StockFlowPort` 只有
`applyAdjustment`（调整已有批次的数量），没有「创建批次」的入口。inventory 模块实现批次落库是
**梁海俊（#137）** 的活，本单只补**端口签名 + 取号器**，让两边能同时开工、互不等待。

**你只做两件事，inventory 模块一行不动。**

## 二、要改的两个文件

### 1. `apps/api/src/platform/services/registry.ts`

在 `StockAdjustmentCommand` 下方新增：

```ts
/** 开批次命令（#136 裁定；A 单入库 / B 单产出共用）。 */
export interface CreateBatchCommand {
  readonly tenantId: string;
  readonly companyId: string;
  readonly productId: string;
  /** 数量（decimal 字符串，D54）；A 单 = 入库量，B 单 = 产出量。 */
  readonly qty: string;
  /** 锁定单位成本（A 单采购价 / B 单加工成本分摊，D5）。 */
  readonly lockedUnitCost: string;
  /** 批次实物责任人（inventory_flow.handled_by 同口径，NOT NULL）。 */
  readonly custodianId: string;
  /** 来源单据：`A` 采购单 / `B` 加工单。 */
  readonly sourceDocType: 'A' | 'B';
  readonly sourceDocId: string;
  /** 经手人（人类发起人；AI 发起时是委托人，D52）。 */
  readonly handledBy: string;
}

export interface CreateBatchReceipt {
  readonly batchId: string;
  readonly batchNo: string;
  readonly availableQty: string;
  readonly custodianId: string;
}
```

并在 `StockFlowPort` 上加一行（**只加签名，不实现**）：

```ts
createBatch(tx: SqlClient, command: CreateBatchCommand): Promise<CreateBatchReceipt>;
```

> 两处口径是我（负责人）在 #136 原文之外补的：① `handledBy` 必须进命令——`inventory_flow.handled_by`
> 是 NOT NULL，不能靠实现方猜；② `batchNo` **不进命令**，由取号器生成，实现方不要自己拼号。

### 2. `apps/api/src/platform/numbering/service.ts`

新增：

- `BATCH_SEQUENCE_MAX = 9999`
- `takeBatchNo(tx: SqlClient, companyId: string, date: Date): Promise<string>`（`date` 必传，与 `takeDocumentNo` 同口径）
  - 格式 `PB-<公司码4>-<日期8>-<流水4>`，例：`PB-0001-20261110-0001`
  - 日期按 **UTC** 取（与现有取号一致），公司码沿用现有 `company_code` 读取方式
  - `scope_key` 用 `` `batch:${companyId}:${monthKey(date)}` `` —— 流水按月复位，跟现有单据取号同口径
  - 流水用满 9999 → 抛 `AppError('VALIDATION_FAILED', ...)`，文案说明「需立项扩容」
  - **禁止**把 `PB` 塞进 `DOCUMENT_TYPES`：那个枚举被 `packages/contracts/src/spec-lock.test.ts` 与
    OpenAPI 锁定，加进去会让 CI 红。批次号是 inventory 自己的编号，不走单据类型表。

单测补在 `apps/api/src/platform/numbering/service.test.ts`（现有 9 条用例的那个文件）：
正常出号、公司码不匹配报错、流水用满报错、跨月复位。

## 三、红线

- 不动 `apps/api/migrations/**`（要加列/加表另开单）
- 不动 `packages/contracts/**`（本单不新增 HTTP 端点，不需要契约）
- 不挂 HTTP 端点、不改 inventory 模块
- 不改其它模块的表或 repo

## 四、PR 要求

- 分支：`feat/platform-createbatch-numbering`
- 标题：`feat(platform): 补 StockFlowPort.createBatch 与批次取号（#162）`
- PR 描述必须含两行（CI 的 `fields` 检查会卡）：`- Blocked by: 无`、`- Blocks: #137`
- 本地验收必须绿：

```powershell
pnpm -C apps/api typecheck
pnpm -C apps/api test -- numbering
pnpm -C apps/api test        # 57 files 全过
```

- 合并后去 #137 留一句「`createBatch` 端口与 `takeBatchNo` 已上主干，可以直接调用」，方便梁海俊接。

## 五、背景资料（省你找上下文）

- 端口约定（D70）：调用方把当前业务事务的 `tx` 传进来；端口实现**不得**自己开事务、
  不得 `withTenant`（租户上下文由调用方保证）；只做业务前置校验，不重复做 scope 判定。
- 批次表 `inventory_batch`（迁移 `0008_inventory_core.sql`）：`batch_no` 租户内唯一、
  `locked_unit_cost amount`、四个数量列；`amount` 域 = `numeric(14,6)`。
- 取号器现有实现就在 `apps/api/src/platform/numbering/service.ts`，照已有 `takeDocumentNo`（L47）
  的写法加一个 `takeBatchNo` 即可（同样的 `number_sequence` 表 + `ON CONFLICT (tenant_id, scope_key)` 单行原子自增）。
- #136 的完整端口形状与 B 单完成端点口径在 issue #136 的评论里；PR #147 已落契约。
