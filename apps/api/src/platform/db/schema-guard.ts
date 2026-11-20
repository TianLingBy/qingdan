import type { Database } from './client.js';
import { SCHEMA_MIGRATIONS_TABLE } from './migrate.js';

/**
 * 启动期结构守卫。
 *
 * 为什么需要：代码一旦依赖新列（例如 0026 的 `settlement_order.settled_at`），
 * 却又连上一个只跑到旧迁移的库，查询会在**运行时**炸在业务路径上（用户看到一个 500），
 * 而不是在启动时炸出来。这里把「库落后于代码」变成启动失败，部署顺序错了立刻可见。
 *
 * 只要求「代码真正依赖的那几条」，不要求是最新迁移：**纯加索引的迁移通常不挡启动**，
 * 除非缺了会让关键查询退化到不可接受的程度，或新查询路径直接依赖它——这类仍要登记，
 * 登记时把「缺了会怎样」写清楚（见 D95 的排序索引）。
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
  // D95 / #341：三个列表的排序复合索引。缺了不会 500，但高频翻页会退化成 Seq Scan + Sort。
  '20261117213000_paging_sort_indexes.sql',
  // D97 / #298 第 2 块：换号用例读写 employee.pending_phone / pending_phone_code_hash /
  // pending_phone_expires_at，并往 login_code 写 purpose='phone_change' 的频控流水。
  // 缺这三列 → 换号端点 500；缺 purpose 放宽 → 频控流水 INSERT 撞 CHECK 约束。
  '20261117220000_settings_center_fields.sql',
  // D98 / #302：主数据静默建档与去重审核依赖的新列与 masterdata_dedupe 表。
  '20261117223000_masterdata_autocreate.sql',
  // D94 / #328：在途可占用要求 available_qty 用“占用优先抵在途”的生成公式；
  // 缺这条会让在途批次一旦被占用就违反非负约束。
  '20261118000000_d94_transit_occupancy.sql',
  // D101 / #101 发起侧：payment_request 表是「发起收款 → 待支付 → 入账」的载体，
  // 发起 / 查单 / mock 确认三个端点都读写它；缺表 → 三条端点全 500。
  '20261118010000_payment_requests.sql',
  // D101 / #101：payment 落进两处 domain 白名单，缺了非老板授不了支付权限（写库会被 CHECK 拦）。
  '20261118020000_payment_permission_domain.sql',
  // D102 / #302 块 C 后半段：审核台直接读 masterdata_dedupe.matched_by，缺列 → 500；
  // 同时带的排序索引缺了不会 500，但按公司+类型+状态排队会退化成 Sort（不是索引级顺序）。
  '20261118030000_masterdata_dedupe_matched_by.sql',
  // D103 / #302 块 D：合并端点写四张主数据表的 `merged_into_id`，并把被并档案置
  // `dedupe_state='merged'`。缺了这一列 → 合并端点 500（写 merged_into_id 时列不存在），
  // 而且是在「引用已经改写了一部分」的事务中途炸，用户只看到一个失败，不知道改没改成。
  '20261118040000_masterdata_merged_into.sql',
  // D92 补句 / #306：三张对接人表 + 三张单据上的 *_contact_id 引用列。
  // 缺表 → 对接人 CRUD 与档案 summary 全 500；缺单头列 → 开单 / 详情查询直接 500
  // （HEADER_COLUMNS 已经 SELECT 这三列）。引用列索引缺了不会 500，
  // 但 ON DELETE RESTRICT 检查与单据列表 LEFT JOIN 会退化。
  '20261118060000_masterdata_contacts.sql',
  // D89 / #289：把 `workbench` 加进 position_permission 与 employee_permission_override
  // 的 domain CHECK 白名单，并给存量岗位 backfill `workbench.read`。
  //
  // **这条漏登记过一段时间，是补的。** 缺了它，`platform/db/seed.ts` 里
  // `ALL_DOMAINS` 含 `workbench`（`:50`）、岗位预设写 `perms('workbench', ['read'])`（`:90`/`:110`），
  // 而 CHECK 白名单只到 `api_integration` —— 新库初始化直接撞约束失败，权限设置页
  // 给任何岗位勾「工作台」也 500。这不是「性能退化」一类的软问题，是写不进去。
  '20261116043100_workbench_position_domain.sql',
  // D90 / #227：把 `view_handler`（看经手人）加进 action CHECK 白名单，并给 owner/manager
  // 补授四类单据域的 view_handler。
  //
  // 同样是补登记的。缺了它：seed 的 `ALL_ACTIONS` 含 `view_handler`（`:53`）、
  // `:87` 写 `perms(domain, ['view_handler'])` → 撞 CHECK 失败；
  // 权限设置页授予「看经手人」也 500。读端只是查不到授权（回 403），不会崩，
  // 但写端崩在初始化阶段，比读端 403 严重得多。
  '20261116154500_allow_view_handler_action.sql',
  // D94 / #402：给存量租户的经理 / 纯仓管 / 采购三个预设补授 `purchase.ship`。
  //
  // 这条是**纯数据 backfill**，缺了不会 500，也不会撞约束——按上面「只登记代码硬依赖」
  // 的口径本可以不入册。登记它是因为后果同样不可接受：三个预设的发货按钮会永久 403，
  // 而这类「功能静默半瘫」在运行时不报错，只能靠启动期检出来提示先去跑 migrate。
  '20261120010000_purchase_ship_preset_backfill.sql',
  // 同上，也是纯数据 backfill，理由一致：采购预设缺这八格的表现是「建不了加工单、
  // 建不了加工厂、供应商退货发起不了」，全部是按钮灰掉而非报错，只能靠启动期提示。
  '20261120020000_purchase_preset_holes_backfill.sql',
  // 同上。这一条更严重：customer_return 整块在非老板预设里都不存在，
  // 表现是「销售建不了客户退货、仓管确认不了」，整个功能只有老板能用。
  '20261120030000_customer_return_preset_backfill.sql',
  // 同上。internal_trade 与 commission 两个域此前在非老板预设里几乎没有格子：
  // 内部交易的发货与到货确认没人能做，销售看不见自己的提成比例。
  '20261120040000_internal_trade_commission_presets_backfill.sql',
  // 第 11 个动作 read_all 的 CHECK 放宽 + 四类单据的 read_all 与几个动作补授权。
  // 缺了它的后果是「写端撞 CHECK」—— 权限设置页勾「看全部」直接 500，
  // 而读端只是 403 看不见，比这条轻得多。
  '20261120050000_read_all_action_and_presets.sql',
  // 上面那条漏了老板预设的 read_all：老板的授权行是 seed 时按当时的 ALL_ACTIONS
  // 展开的，read_all 后加进来，老库里就没这一格。缺了它前端「看谁的」下拉不出现、
  // `?scope=all` 直接 403 —— 表现为「老板也不能看全部」，静默而不报错。
  '20261120060000_owner_read_all_backfill.sql',
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
