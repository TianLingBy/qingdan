import type { Database } from './client.js';
import { SCHEMA_MIGRATIONS_TABLE } from './migrate.js';

/**
 * 启动期结构守卫。
 *
 * 为什么需要：代码一旦依赖新列（例如 0026 的 `settlement_order.settled_at`），
 * 却又连上一个只跑到旧迁移的库，查询会在**运行时**炸在业务路径上（用户看到一个 500），
 * 而不是在启动时炸出来。这里把「库落后于代码」变成启动失败，部署顺序错了立刻可见。
 *
 * 只要求「代码真正依赖的那几条」，不要求是最新迁移：只加索引/触发器的迁移
 * （如 0027）缺了最多是少一层防线，不该挡住启动。
 */

/** 代码硬依赖的迁移：缺一条就拒绝启动。新增依赖时在这里登记。 */
export const REQUIRED_MIGRATIONS: readonly string[] = [
  '0026_settlement_orders_settled_at.sql',
  // D88 / #288：撤销结算把结算期快照列置 NULL，20261116043000 必须已应用。
  '20261116043000_settlement_orders_unsettle.sql',
  // D93 / #298：概览直接读 company 的 address / contact_phone / tax_no / logo_url，
  // 缺列会在业务路径上 500，必须启动时就报出来。
  '20261117090000_settings_center_fields.sql',
  // D94 / #330：在途状态依赖 purchase_order_line.transit_to / processor_id、
  // processing_order.transit_stage / transit_to、inventory_batch.held_by_processor_id，
  // 缺列会让发货 / 到货确认直接 500，必须在启动时就报出来。
  '20261117181000_d94_transit_states.sql',
];

export class SchemaOutOfDateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaOutOfDateError';
  }
}

export async function assertSchemaReady(
  database: Database,
  required: readonly string[] = REQUIRED_MIGRATIONS,
): Promise<void> {
  let applied: Set<string>;
  try {
    const result = await database.query<{ id: string }>(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`);
    applied = new Set(result.rows.map((row) => row.id));
  } catch (error) {
    throw new SchemaOutOfDateError(
      `数据库还没有跑过迁移（读不到 ${SCHEMA_MIGRATIONS_TABLE}）。先执行 \`pnpm -C apps/api migrate\`，再启动 API。`,
      { cause: error },
    );
  }

  const missing = required.filter((id) => !applied.has(id));
  if (missing.length > 0) {
    throw new SchemaOutOfDateError(
      `数据库结构落后于代码：缺少迁移 ${missing.join('、')}。` +
        '先执行 `pnpm -C apps/api migrate`（先备份，见 docs/runbook-0026-settled-at.md），再启动 API。' +
        '不要用旧库跑新代码。',
    );
  }
}
