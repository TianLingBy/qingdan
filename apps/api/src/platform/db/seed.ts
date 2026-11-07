import { createPgDatabase, type Database, type SqlClient } from './client.js';
import { takeEmployeeNo } from '../numbering/service.js';

/**
 * 演示数据 seed（可重复执行）：
 *   - 1 个租户 + 1 家公司（公司码 0001，单号里用）；
 *   - 7 套出厂预设岗位（F8 / D4：老板、销售、销售+仓管、财务+销售、纯仓管、采购、经理）；
 *   - 老板 / 经理 / 销售 / 仓管 四名员工，工号走并发安全取号（D48）；
 *   - 打印账号（工号 + 手机号占位号，不写真实手机号）。
 *
 * 岗位权限是**演示用初值**，不等于已拍板的权限矩阵（能力矩阵 domain-model §6-M4 仍 ⬜）。
 */

const DEMO_TENANT_ID = '01900000-0000-7000-8000-000000000001';
const DEMO_COMPANY_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_NAME = '演示企业';
const COMPANY_NAME = '演示公司';

type Perm = readonly [domain: string, action: string];

/** 出厂预设岗位的稳定标识（0003_platform_preset_key.sql 的 CHECK 允许值）。 */
type PresetKey =
  | 'owner'
  | 'manager'
  | 'finance'
  | 'sales'
  | 'purchase'
  | 'quality'
  | 'picking'
  | 'warehouse';

interface PositionSeed {
  readonly id: string;
  readonly name: string;
  readonly kind: '预设' | '自定义';
  readonly isSystem: boolean;
  /**
   * F8 七套岗位包按主业务键登记：组合包（销售+仓管、财务+销售）取组合里的
   * 主岗位键；质检 / 拣货目前没有独立出厂岗位行（F8 只列七套），故 seed 不造行。
   * 边界判定只关心 manager / finance（D50）。
   */
  readonly presetKey: PresetKey | null;
  readonly permissions: readonly Perm[];
}

const ALL_DOMAINS = [
  'purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'commission',
  'customer_return', 'supplier_return', 'stocktake', 'product', 'customer', 'supplier',
  'processor', 'inventory_qty', 'inventory_flow', 'stocktake_page', 'employee',
  'permission', 'company', 'profit_report', 'audit', 'api_integration',
] as const;

const ALL_ACTIONS = ['read', 'create', 'update', 'approve', 'ship', 'delete', 'view_price', 'export'] as const;

function perms(domain: string, actions: readonly string[]): Perm[] {
  return actions.map((action) => [domain, action] as const);
}

const POSITIONS: readonly PositionSeed[] = [
  {
    id: '01900000-0000-7000-8000-000000000011',
    name: '老板',
    kind: '预设',
    isSystem: true,
    presetKey: 'owner',
    permissions: ALL_DOMAINS.flatMap((domain) => perms(domain, ALL_ACTIONS)),
  },
  {
    id: '01900000-0000-7000-8000-000000000012',
    name: '经理',
    kind: '预设',
    isSystem: true,
    presetKey: 'manager',
    permissions: [
      ...['purchase', 'processing', 'sales', 'internal_trade', 'settlement', 'customer_return',
        'supplier_return', 'product', 'customer', 'supplier', 'processor',
        'inventory_qty', 'inventory_flow', 'company', 'profit_report'].flatMap((domain) =>
        perms(domain, ['read']),
      ),
      // D71：经理可录盘盈/盘亏，且按 D47「老板或经理审批」必须持 approve。
      ...perms('stocktake', ['read', 'create', 'delete', 'approve']),
      ...perms('employee', ['read']),
      ...perms('permission', ['read', 'update']),
      ...perms('audit', ['read']),
    ],
  },
  {
    id: '01900000-0000-7000-8000-000000000013',
    name: '销售',
    kind: '预设',
    isSystem: true,
    presetKey: 'sales',
    permissions: [
      ...perms('sales', ['read', 'create', 'update', 'view_price']),
      ...perms('customer', ['read', 'create', 'update']),
      ...perms('product', ['read']),
      ...perms('inventory_qty', ['read']),
      ...perms('settlement', ['read']),
    ],
  },
  {
    id: '01900000-0000-7000-8000-000000000014',
    name: '销售+仓管',
    kind: '预设',
    isSystem: true,
    presetKey: 'sales',
    permissions: [
      ...perms('sales', ['read', 'create', 'update', 'ship', 'view_price']),
      ...perms('customer', ['read', 'create', 'update']),
      ...perms('product', ['read']),
      ...perms('inventory_qty', ['read', 'update']),
      ...perms('inventory_flow', ['read', 'create']),
      ...perms('stocktake', ['read']),
      ...perms('processing', ['read']),
    ],
  },
  {
    id: '01900000-0000-7000-8000-000000000015',
    name: '财务+销售',
    kind: '预设',
    isSystem: true,
    presetKey: 'finance',
    permissions: [
      ...perms('settlement', ['read', 'create', 'update', 'approve', 'view_price']),
      ...perms('profit_report', ['read', 'export']),
      ...perms('audit', ['read']),
      ...perms('sales', ['read', 'view_price']),
    ],
  },
  {
    id: '01900000-0000-7000-8000-000000000016',
    name: '纯仓管',
    kind: '预设',
    isSystem: true,
    presetKey: 'warehouse',
    permissions: [
      ...perms('inventory_qty', ['read', 'update']),
      ...perms('inventory_flow', ['read', 'create']),
      ...perms('stocktake_page', ['read', 'create']),
      // D47「理货可发起减少调整申请」+ D71：仓管只给删减（盘亏），不给盘盈。
      ...perms('stocktake', ['read', 'delete']),
      ...perms('processing', ['read', 'update']),
      ...perms('purchase', ['read']),
    ],
  },
  {
    id: '01900000-0000-7000-8000-000000000017',
    name: '采购',
    kind: '预设',
    isSystem: true,
    presetKey: 'purchase',
    permissions: [
      ...perms('purchase', ['read', 'create', 'update', 'approve']),
      ...perms('product', ['read', 'create', 'update']),
      ...perms('supplier', ['read', 'create', 'update']),
      ...perms('inventory_qty', ['read']),
      // D71：采购可录盘盈盘亏（两个方向都可发起），审批仍归老板/经理。
      ...perms('stocktake', ['read', 'create', 'delete']),
      ...perms('settlement', ['read']),
    ],
  },
];

interface EmployeeSeed {
  readonly id: string;
  readonly name: string;
  /** 占位手机号：11 位、以 1 开头（满足 D13 校验），但不是真实号段。 */
  readonly phone: string;
  readonly isOwner: boolean;
  readonly positionId: string;
}

const EMPLOYEES: readonly EmployeeSeed[] = [
  { id: '01900000-0000-7000-8000-000000000021', name: '张明', phone: '10000000001', isOwner: true, positionId: POSITIONS[0]!.id },
  { id: '01900000-0000-7000-8000-000000000022', name: '李强', phone: '10000000002', isOwner: false, positionId: POSITIONS[1]!.id },
  { id: '01900000-0000-7000-8000-000000000023', name: '王芳', phone: '10000000003', isOwner: false, positionId: POSITIONS[2]!.id },
  { id: '01900000-0000-7000-8000-000000000024', name: '赵刚', phone: '10000000004', isOwner: false, positionId: POSITIONS[5]!.id },
];

async function seedTenant(tx: SqlClient): Promise<void> {
  await tx.query(
    `INSERT INTO tenant (id, name, plan, status) VALUES ($1, $2, '基础版', '启用')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_TENANT_ID, TENANT_NAME],
  );
  await tx.query(
    `INSERT INTO company (id, tenant_id, name, code, level, status)
     VALUES ($1, $2, $3, '0001', 1, '启用')
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_COMPANY_ID, DEMO_TENANT_ID, COMPANY_NAME],
  );

  for (const position of POSITIONS) {
    await tx.query(
      `INSERT INTO position (id, tenant_id, name, kind, is_system, scope, status, preset_key)
       VALUES ($1, $2, $3, $4, $5, '租户级', '启用', $6)
       ON CONFLICT (id) DO UPDATE SET preset_key = EXCLUDED.preset_key`,
      [
        position.id,
        DEMO_TENANT_ID,
        position.name,
        position.kind,
        position.isSystem,
        position.presetKey,
      ],
    );
    for (const [domain, action] of position.permissions) {
      await tx.query(
        `INSERT INTO position_permission (tenant_id, position_id, domain, action, granted)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (position_id, domain, action) DO UPDATE SET granted = true`,
        [DEMO_TENANT_ID, position.id, domain, action],
      );
    }
  }

  for (const employee of EMPLOYEES) {
    const existing = await tx.query('SELECT 1 FROM employee WHERE id = $1', [employee.id]);
    if (existing.rows.length > 0) continue;
    // 工号走并发安全取号：全租户单调递增（D48）。
    const employeeNo = await takeEmployeeNo(tx, DEMO_TENANT_ID);
    await tx.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name, status, is_owner)
       VALUES ($1, $2, $3, $4, $5, '在职', $6)`,
      [employee.id, DEMO_TENANT_ID, employeeNo, employee.phone, employee.name, employee.isOwner],
    );
    await tx.query(
      `INSERT INTO employee_company_position (tenant_id, employee_id, company_id, position_id)
       VALUES ($1, $2, $3, $4)`,
      [DEMO_TENANT_ID, employee.id, DEMO_COMPANY_ID, employee.positionId],
    );
  }
}

interface AccountRow {
  employee_no: string;
  phone: string;
  name: string;
  position_name: string;
  is_owner: boolean;
}

async function printAccounts(db: Database): Promise<void> {
  const result = await db.query<AccountRow>(
    `SELECT e.employee_no, e.phone, e.name, p.name AS position_name, e.is_owner
     FROM employee e
     LEFT JOIN employee_company_position ecp ON ecp.employee_id = e.id
     LEFT JOIN position p ON p.id = ecp.position_id
     WHERE e.tenant_id = $1
     ORDER BY e.employee_no, p.name`,
    [DEMO_TENANT_ID],
  );
  console.log(`演示数据已就绪：租户「${TENANT_NAME}」/ 公司「${COMPANY_NAME}」(公司码 0001)`);
  console.log('  工号    手机号       姓名  岗位      老板');
  for (const row of result.rows) {
    console.log(
      `  ${row.employee_no}  ${row.phone}  ${row.name}  ${(row.position_name ?? '-').padEnd(6, ' ')}  ${
        row.is_owner ? '是' : '否'
      }`,
    );
  }
  console.log('提示：一期不发验证码，登录账号由后台/初始化脚本创建；以上手机号为占位号。');
}

export async function seed(db: Database): Promise<void> {
  const existing = await db.query('SELECT 1 FROM tenant WHERE id = $1', [DEMO_TENANT_ID]);
  if (existing.rows.length === 0) {
    await db.transaction(seedTenant);
  } else {
    console.log('演示租户已存在，跳过写入（幂等）。');
  }
  await printAccounts(db);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('缺少 DATABASE_URL，无法 seed');
    process.exitCode = 1;
    return;
  }
  const { database } = createPgDatabase(databaseUrl);
  try {
    await seed(database);
  } finally {
    await database.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[seed] 失败', error);
    process.exitCode = 1;
  });
}

export const DEMO_IDS = {
  tenantId: DEMO_TENANT_ID,
  companyId: DEMO_COMPANY_ID,
  ownerEmployeeId: EMPLOYEES[0]!.id,
  managerEmployeeId: EMPLOYEES[1]!.id,
  salesEmployeeId: EMPLOYEES[2]!.id,
  warehouseEmployeeId: EMPLOYEES[3]!.id,
} as const;
