import { v7 as uuidv7 } from 'uuid';
import { ACTOR_TYPES, AUDIT_RESULTS, type AuditSource } from '@qingdan/contracts';
import type { Database, SqlClient } from '../db/client.js';

/**
 * 审计追加器（D51 / D55⑤）。
 *
 * 两段式：
 *   1. 业务事务内写 `audit_outbox`（`appendAudit`）——写失败 ⇒ 业务事务回滚，业务失败（F1，被 U5 覆盖）；
 *   2. 业务提交后 `flushAuditOutbox` 把 outbox 行搬到只追加的 `audit_log`（F2）。F2 物理上无法回滚业务，
 *      但**必须抛出**（宁可 500 也不漏记），并交给上层告警/对账。
 *
 * 失败路径（业务本身失败、无业务事务）用 `recordAuditFailure` 直接写 `result='fail'`。
 * 任何审计写入异常都不吞：没有 `try/catch` 兜底，异常原样上抛（D55⑤）。
 */

export type ActorType = (typeof ACTOR_TYPES)[number];
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface AuditEvent {
  /** 省略时由追加器生成 UUIDv7；重试场景可显式传入以保幂等。 */
  readonly id?: string;
  readonly occurredAt?: Date;
  readonly tenantId: string | null;
  readonly companyId?: string | null;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly credentialId?: string | null;
  readonly source: AuditSource;
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string | null;
  readonly changeSummary?: Record<string, unknown> | null;
  readonly result: AuditResult;
  readonly errorCode?: string | null;
  readonly requestId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly reason?: string | null;
  readonly businessTxId?: string | null;
  readonly dryRun?: boolean;
}

const COLUMN_LIST = `id, occurred_at, tenant_id, company_id, actor_type, actor_id, credential_id,
  source, action, object_type, object_id, changes, result, error_code, request_id,
  ip, user_agent, reason, business_txn_id, dry_run`;

const INSERT_COLUMNS = `(${COLUMN_LIST})`;

function valuesOf(event: AuditEvent, id: string): unknown[] {
  return [
    id,
    event.occurredAt ?? new Date(),
    event.tenantId,
    event.companyId ?? null,
    event.actorType,
    event.actorId,
    event.credentialId ?? null,
    event.source,
    event.action,
    event.objectType,
    event.objectId ?? null,
    event.changeSummary ? JSON.stringify(event.changeSummary) : null,
    event.result,
    event.errorCode ?? null,
    event.requestId,
    event.ip ?? null,
    event.userAgent ?? null,
    event.reason ?? null,
    event.businessTxId ?? null,
    event.dryRun ?? false,
  ];
}

const PLACEHOLDERS = '($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)';

/**
 * 在业务事务内写 outbox。**不捕获异常**：调用方事务因此回滚，业务随之失败。
 */
export async function appendAudit(tx: SqlClient, event: AuditEvent): Promise<string> {
  const id = event.id ?? uuidv7();
  await tx.query(`INSERT INTO audit_outbox ${INSERT_COLUMNS} VALUES ${PLACEHOLDERS}`, valuesOf(event, id));
  return id;
}

/**
 * 提交后把 outbox 行搬到 audit_log（幂等：已存在则跳过，再删除 outbox 行）。
 * 失败直接抛出；找不到 outbox 行也视作「已被搬过」，幂等返回。
 */
export async function flushAuditOutbox(db: Database, auditId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO audit_log ${INSERT_COLUMNS}
       SELECT ${COLUMN_LIST} FROM audit_outbox
       WHERE id = $1
       ON CONFLICT (id) DO NOTHING`,
      [auditId],
    );
    await tx.query('DELETE FROM audit_outbox WHERE id = $1', [auditId]);
  });
}

/**
 * 直接写一条 `result='fail'` 的日志（无业务事务的失败路径）。
 */
export async function recordAuditFailure(db: Database, event: AuditEvent): Promise<string> {
  const id = event.id ?? uuidv7();
  const values = valuesOf({ ...event, result: 'fail' }, id);
  await db.query(`INSERT INTO audit_log ${INSERT_COLUMNS} VALUES ${PLACEHOLDERS}`, values);
  return id;
}

/**
 * 带审计的业务事务：
 *   BEGIN → work(tx) → 写 outbox → COMMIT → 搬 log。
 * 任何一步失败都抛出；前两步失败会回滚业务写入。
 */
export async function withAudit<T>(
  db: Database,
  event: AuditEvent,
  work: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const auditId = event.id ?? uuidv7();
  const value = await db.transaction(async (tx) => {
    const result = await work(tx);
    await appendAudit(tx, { ...event, id: auditId });
    return result;
  });
  // F2：业务已提交，这里失败无法回滚业务，但绝不吞异常（上层返回 500 + 告警/对账）。
  await flushAuditOutbox(db, auditId);
  return value;
}
