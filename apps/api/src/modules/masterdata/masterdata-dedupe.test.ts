import { randomUUID } from 'node:crypto';
import type { DedupeKind } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { loadMigrationFiles } from '../../platform/db/migrate.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 去重审核台（#302 块 C 后半段 / D102）HTTP 行为。
 *
 * 覆盖「必须做对的事」：
 *   - 无 `customer.read` → 403，且响应体里**没有 `items`**（空数组等于「没有待审」，会骗人）；
 *   - `companyId` 不可见 → 403（同样不是 200 空数组）；
 *   - list 默认只回 `pending`，`state=kept` 才回已判为不同的；
 *   - `left` / `right` 两侧都带 `name`（只给 id 的接口审核台用不了）；
 *   - keep-separate 之后默认列表里消失、`state=kept` 才出现，且 `decided_by` 记的是员工 id；
 *   - 对已判定的行再判定 → 409；reopen 后回 `pending` 并清空 decided_at / decided_by；
 *   - `merged` 不许 reopen（409）；
 *   - 迁移把老 `note` 里的 `matched_by` 前缀摘进独立列（含「只有前缀、没有备注」的情况）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const SALES_PHONE = '10000000003';
const WAREHOUSE_PHONE = '10000000004';

/** 第二家公司：只用来验证「不可见公司 → 403」。 */
const SECOND_COMPANY_ID = '01900000-0000-7000-8000-000000000003';

/** 经理岗位（seed 的 POSITIONS[1]）：测试里撤掉它的 `supplier.merge`。 */
const MANAGER_POSITION_ID = '01900000-0000-7000-8000-000000000012';

interface DedupeArchiveBody {
  id: string;
  name: string | null;
  contactPhone: string | null;
  specification: string | null;
}

interface DedupeItemBody {
  id: string;
  kind: string;
  score: number;
  matchedBy: string;
  note: string | null;
  state: string;
  createdAt: string;
  left: DedupeArchiveBody;
  right: DedupeArchiveBody;
}

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

/** Cookie 认证的非安全请求需要同源 Origin（D59⑧）。 */
function writeHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId };
}

async function login(app: FastifyInstance, phone: string, requestId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-request-id': requestId },
    payload: { phone, code: '000000' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

describe('去重审核台（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;
  let salesCookie: string;
  let warehouseCookie: string;

  /** 按类型插档案：四张表必填列不同（product 要 unit，processor 连电话列都没有）。 */
  async function insertArchive(
    kind: DedupeKind,
    name: string,
    options: { contactPhone?: string | null; specification?: string | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    if (kind === 'product') {
      await test.database.query(
        `INSERT INTO product (id, tenant_id, company_id, name, unit, specification)
         VALUES ($1, $2, $3, $4, '件', $5)`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name, options.specification ?? null],
      );
    } else if (kind === 'processor') {
      await test.database.query(
        `INSERT INTO processor (id, tenant_id, company_id, name) VALUES ($1, $2, $3, $4)`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name],
      );
    } else {
      await test.database.query(
        `INSERT INTO ${kind} (id, tenant_id, company_id, name, contact_phone)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, name, options.contactPhone ?? null],
      );
    }
    return id;
  }

  interface PairFixture {
    readonly kind: DedupeKind;
    readonly pairId: string;
    readonly leftId: string;
    readonly rightId: string;
    readonly leftName: string;
    readonly rightName: string;
  }

  /** 造一对档案 + 一条队列行（直接写库：队列本该由建档流程写入，这里要精确控制状态）。 */
  async function createPair(options: {
    kind?: DedupeKind;
    leftName: string;
    rightName: string;
    score?: string;
    matchedBy?: string;
    note?: string | null;
    state?: 'pending' | 'kept' | 'merged';
    contactPhone?: string | null;
  }): Promise<PairFixture> {
    const kind = options.kind ?? 'customer';
    const state = options.state ?? 'pending';
    const leftId = await insertArchive(kind, options.leftName, {
      contactPhone: options.contactPhone ?? null,
    });
    const rightId = await insertArchive(kind, options.rightName);
    // 与 recordDedupeCandidate 一致：小的一侧放 left_id（唯一约束不知道对称性）。
    // 谁落 left 谁落 right 取决于 uuid 大小，故 leftName / rightName 跟着实际落位返回。
    const swapped = leftId > rightId;
    const [a, b] = swapped ? [rightId, leftId] : [leftId, rightId];
    const pairId = randomUUID();
    await test.database.query(
      `INSERT INTO masterdata_dedupe
         (id, tenant_id, company_id, kind, left_id, right_id, score, matched_by, note,
          state, decided_at, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12)`,
      [
        pairId,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        kind,
        a,
        b,
        options.score ?? '0.950',
        options.matchedBy ?? 'name_only',
        options.note ?? null,
        state,
        state === 'pending' ? null : new Date().toISOString(),
        state === 'pending' ? null : DEMO_IDS.managerEmployeeId,
      ],
    );
    return {
      kind,
      pairId,
      leftId: a,
      rightId: b,
      leftName: swapped ? options.rightName : options.leftName,
      rightName: swapped ? options.leftName : options.rightName,
    };
  }

  async function list(
    cookie: string,
    requestId: string,
    query: Record<string, string> = {},
  ): Promise<{ statusCode: number; items?: DedupeItemBody[]; code?: string; body: unknown }> {
    const params = new URLSearchParams({ companyId: DEMO_IDS.companyId, ...query });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/masterdata/dedupe?${params.toString()}`,
      headers: readHeaders(cookie, requestId),
    });
    const body = response.json() as { items?: DedupeItemBody[]; code?: string };
    return { statusCode: response.statusCode, items: body.items, code: body.code, body };
  }

  async function decide(
    cookie: string,
    requestId: string,
    pairId: string,
    action: 'keep-separate' | 'reopen',
    reason = '两家不是同一个客户',
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/masterdata/dedupe/${pairId}/${action}`,
      headers: writeHeaders(cookie, requestId),
      payload: { reason },
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [SECOND_COMPANY_ID, DEMO_IDS.tenantId],
    );

    // 经理默认四类 `merge` 全有（D98）。撤掉 `supplier.merge` 才能测出「按 kind 分别鉴权」：
    // 有 `customer.merge` 的人在供应商对子上必须 403（岗位权限只是初值，随时可撤——权限模型铁律）。
    await test.database.query(
      `UPDATE position_permission SET granted = false
        WHERE tenant_id = $1 AND position_id = $2 AND domain = 'supplier' AND action = 'merge'`,
      [DEMO_IDS.tenantId, MANAGER_POSITION_ID],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();

    ownerCookie = await login(app, OWNER_PHONE, 'req-dedupe-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-dedupe-login-manager');
    salesCookie = await login(app, SALES_PHONE, 'req-dedupe-login-sales');
    warehouseCookie = await login(app, WAREHOUSE_PHONE, 'req-dedupe-login-warehouse');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('四类主数据一类都读不了（纯仓管）→ 403，且响应体里没有 items', async () => {
    const result = await list(warehouseCookie, 'req-dedupe-no-perm');
    expect(result.statusCode).toBe(403);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.body).not.toHaveProperty('items');
  });

  it('只按调用者持有的 *.read 出类型：销售（customer+product）看不到供应商/加工厂对子', async () => {
    const customerPair = await createPair({ leftName: '销售可见客户甲', rightName: '销售可见客户乙' });
    const supplierPair = await createPair({
      kind: 'supplier',
      leftName: '销售不可见供应商甲',
      rightName: '销售不可见供应商乙',
    });
    const processorPair = await createPair({
      kind: 'processor',
      leftName: '销售不可见加工厂甲',
      rightName: '销售不可见加工厂乙',
    });

    const result = await list(salesCookie, 'req-dedupe-kind-filter');
    expect(result.statusCode).toBe(200);
    const kinds = new Set(result.items!.map((item) => item.kind));
    // 销售只有 customer.read / product.read。
    expect(kinds.has('supplier')).toBe(false);
    expect(kinds.has('processor')).toBe(false);
    expect(result.items!.some((item) => item.id === customerPair.pairId)).toBe(true);
    expect(result.items!.some((item) => item.id === supplierPair.pairId)).toBe(false);
    expect(result.items!.some((item) => item.id === processorPair.pairId)).toBe(false);

    // 点名要自己没有读权限的类型 → 403（空列表等于暗示「这类没有重复」）。
    const forbiddenKind = await list(salesCookie, 'req-dedupe-kind-forbidden', { kind: 'supplier' });
    expect(forbiddenKind.statusCode).toBe(403);
    expect(forbiddenKind.body).not.toHaveProperty('items');
  });

  it('companyId 不在可见集合内 → 403（不是 200 空列表）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/masterdata/dedupe?companyId=${SECOND_COMPANY_ID}`,
      headers: readHeaders(salesCookie, 'req-dedupe-other-company'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(response.json()).not.toHaveProperty('items');
  });

  it('缺 companyId → 422（服务端不猜「默认公司」）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/masterdata/dedupe',
      headers: readHeaders(ownerCookie, 'req-dedupe-no-company'),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('默认只回 pending；state=kept 才回已判为不同的对子', async () => {
    const pending = await createPair({ leftName: '默认待判甲', rightName: '默认待判乙' });
    const kept = await createPair({
      leftName: '已判不同甲',
      rightName: '已判不同乙',
      state: 'kept',
    });

    const defaults = await list(ownerCookie, 'req-dedupe-default');
    expect(defaults.statusCode).toBe(200);
    expect(defaults.items!.every((item) => item.state === 'pending')).toBe(true);
    expect(defaults.items!.some((item) => item.id === pending.pairId)).toBe(true);
    expect(defaults.items!.some((item) => item.id === kept.pairId)).toBe(false);

    const keptOnly = await list(ownerCookie, 'req-dedupe-kept', { state: 'kept' });
    expect(keptOnly.statusCode).toBe(200);
    expect(keptOnly.items!.every((item) => item.state === 'kept')).toBe(true);
    expect(keptOnly.items!.some((item) => item.id === kept.pairId)).toBe(true);
    expect(keptOnly.items!.some((item) => item.id === pending.pairId)).toBe(false);
  });

  it('两侧档案都带名字与命中依据（审核台要显示「张记建材 vs 张记建材店」）', async () => {
    const pair = await createPair({
      leftName: '张记建材',
      rightName: '张记建材店',
      matchedBy: 'name_phone',
      score: '0.870',
      contactPhone: '13900001111',
    });

    const result = await list(ownerCookie, 'req-dedupe-names');
    const item = result.items!.find((row) => row.id === pair.pairId);
    expect(item).toBeDefined();
    expect(item!.matchedBy).toBe('name_phone');
    expect(item!.score).toBeCloseTo(0.87, 3);
    // 两侧都要有名字，且各自对上自己的那一侧档案（不是把 left 的名字错贴到 right）。
    expect(item!.left.id).toBe(pair.leftId);
    expect(item!.right.id).toBe(pair.rightId);
    expect([item!.left.name, item!.right.name].sort()).toEqual(['张记建材', '张记建材店']);
    // 客户有电话、没有规格：取不到的给 null，不用空字符串冒充「没填」。
    const withPhone = [item!.left, item!.right].find((archive) => archive.name === '张记建材')!;
    expect(withPhone.contactPhone).toBe('13900001111');
    expect(item!.left.specification).toBeNull();
    expect(item!.right.specification).toBeNull();
  });

  it('keep-separate 之后默认列表消失、state=kept 才出现，decided_by 记员工 id', async () => {
    const pair = await createPair({ leftName: '判为不同甲', rightName: '判为不同乙' });

    const decided = await decide(managerCookie, 'req-dedupe-keep', pair.pairId, 'keep-separate');
    expect(decided.statusCode).toBe(200);
    expect(decided.body).toMatchObject({ id: pair.pairId, state: 'kept' });
    expect(typeof decided.body.decidedAt).toBe('string');

    const defaults = await list(ownerCookie, 'req-dedupe-keep-default');
    expect(defaults.items!.some((item) => item.id === pair.pairId)).toBe(false);
    const keptList = await list(ownerCookie, 'req-dedupe-keep-list', { state: 'kept' });
    expect(keptList.items!.some((item) => item.id === pair.pairId)).toBe(true);

    const { rows } = await test.database.query<{ decided_by: string | null; decided_at: unknown }>(
      `SELECT decided_by::text AS decided_by, decided_at FROM masterdata_dedupe WHERE id = $1`,
      [pair.pairId],
    );
    expect(rows[0]!.decided_by).toBe(DEMO_IDS.managerEmployeeId);
    expect(rows[0]!.decided_at).not.toBeNull();
  });

  it('无 customer.merge → 403（销售能读客户，但不能判定合并/不合并）', async () => {
    const pair = await createPair({ leftName: '销售无权甲', rightName: '销售无权乙' });
    const result = await decide(salesCookie, 'req-dedupe-no-merge', pair.pairId, 'keep-separate');
    expect(result.statusCode).toBe(403);
    expect(result.body.code).toBe('FORBIDDEN');

    const { rows } = await test.database.query<{ state: string }>(
      `SELECT state FROM masterdata_dedupe WHERE id = $1`,
      [pair.pairId],
    );
    expect(rows[0]!.state).toBe('pending');
  });

  it('按 kind 分别鉴权：有 customer.merge 没有 supplier.merge 的人，供应商对子必须 403', async () => {
    const customerPair = await createPair({ leftName: '类型鉴权客户甲', rightName: '类型鉴权客户乙' });
    const supplierPair = await createPair({
      kind: 'supplier',
      leftName: '类型鉴权供应商甲',
      rightName: '类型鉴权供应商乙',
    });

    // 同一个 principal：客户对子能判（有 customer.merge，经理岗位默认持有）。
    const allowed = await decide(managerCookie, 'req-dedupe-kind-allow', customerPair.pairId, 'keep-separate');
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.state).toBe('kept');

    // 供应商对子 403：manager 的 supplier.merge 在 beforeAll 里被撤掉了。
    const denied = await decide(managerCookie, 'req-dedupe-kind-deny', supplierPair.pairId, 'keep-separate');
    expect(denied.statusCode).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    // 越权请求不能悄悄改状态。
    const { rows } = await test.database.query<{ state: string; decided_by: string | null }>(
      `SELECT state, decided_by::text AS decided_by FROM masterdata_dedupe WHERE id = $1`,
      [supplierPair.pairId],
    );
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.decided_by).toBeNull();
  });

  it('reopen 同样按 kind 鉴权：供应商已判行 403（即使有 customer.merge）', async () => {
    const supplierPair = await createPair({
      kind: 'supplier',
      leftName: '供应商撤销甲',
      rightName: '供应商撤销乙',
      state: 'kept',
    });
    const result = await decide(managerCookie, 'req-dedupe-kind-reopen', supplierPair.pairId, 'reopen');
    expect(result.statusCode).toBe(403);
    expect(result.body.code).toBe('FORBIDDEN');

    const { rows } = await test.database.query<{ state: string }>(
      `SELECT state FROM masterdata_dedupe WHERE id = $1`,
      [supplierPair.pairId],
    );
    expect(rows[0]!.state).toBe('kept');
  });

  it('对已 kept 的行再 keep-separate → 409 STATE_CONFLICT（不覆盖前一个人的判定）', async () => {
    const pair = await createPair({
      leftName: '重复判定甲',
      rightName: '重复判定乙',
      state: 'kept',
    });
    const result = await decide(managerCookie, 'req-dedupe-conflict', pair.pairId, 'keep-separate');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('STATE_CONFLICT');
  });

  it('reopen 之后回 pending，decided_at / decided_by 被清空', async () => {
    const pair = await createPair({
      leftName: '撤销甲',
      rightName: '撤销乙',
      state: 'kept',
    });

    const reopened = await decide(managerCookie, 'req-dedupe-reopen', pair.pairId, 'reopen');
    expect(reopened.statusCode).toBe(200);
    expect(reopened.body).toMatchObject({ id: pair.pairId, state: 'pending', decidedAt: null });

    const { rows } = await test.database.query<{ decided_by: string | null; decided_at: unknown }>(
      `SELECT decided_by::text AS decided_by, decided_at FROM masterdata_dedupe WHERE id = $1`,
      [pair.pairId],
    );
    expect(rows[0]!.decided_by).toBeNull();
    expect(rows[0]!.decided_at).toBeNull();

    // 回到待判之后，默认列表里又能看到它。
    const defaults = await list(ownerCookie, 'req-dedupe-reopen-list');
    expect(defaults.items!.some((item) => item.id === pair.pairId)).toBe(true);
  });

  it('merged 状态不许 reopen → 409（合并已改写引用，改状态撤销不了）', async () => {
    const pair = await createPair({
      leftName: '已合并甲',
      rightName: '已合并乙',
      state: 'merged',
    });
    const result = await decide(managerCookie, 'req-dedupe-merged', pair.pairId, 'reopen');
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe('STATE_CONFLICT');

    const { rows } = await test.database.query<{ state: string }>(
      `SELECT state FROM masterdata_dedupe WHERE id = $1`,
      [pair.pairId],
    );
    expect(rows[0]!.state).toBe('merged');
  });
});

describe('迁移 backfill：note 里的 matched_by 前缀搬进独立列', () => {
  const MIGRATION_ID = '20261118030000_masterdata_dedupe_matched_by.sql';

  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await seed(db.database);
  });

  afterAll(async () => {
    await db.database.close();
  });

  it('note=name_phone|同名不同规格 → matched_by=name_phone、note=同名不同规格；note=name_only → matched_by=name_only、note=NULL', async () => {
    // 回到 20261117223000 的样子：没有 matched_by 列、没有审核台索引。
    await db.database.exec('ALTER TABLE masterdata_dedupe DROP COLUMN matched_by');
    await db.database.exec('DROP INDEX IF EXISTS masterdata_dedupe_console_idx');

    const ids = {
      withNote: '01900000-0000-7000-8000-00000000aa01',
      prefixOnly: '01900000-0000-7000-8000-00000000aa02',
      left: '01900000-0000-7000-8000-00000000aa03',
      right: '01900000-0000-7000-8000-00000000aa04',
      left2: '01900000-0000-7000-8000-00000000aa05',
      right2: '01900000-0000-7000-8000-00000000aa06',
    };
    for (const id of [ids.left, ids.right, ids.left2, ids.right2]) {
      await db.database.query(
        `INSERT INTO customer (id, tenant_id, company_id, name) VALUES ($1, $2, $3, '迁移测试客户')`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId],
      );
    }
    // 老格式：编码器写的 `<matched_by>` 与 `<matched_by>|<人工备注>`。
    // 两行必须落在不同的对子上（UNIQUE (kind,left_id,right_id)）。
    for (const [id, note, leftId, rightId] of [
      [ids.withNote, 'name_phone|同名不同规格', ids.left, ids.right],
      [ids.prefixOnly, 'name_only', ids.left2, ids.right2],
    ] as const) {
      await db.database.query(
        `INSERT INTO masterdata_dedupe
           (id, tenant_id, company_id, kind, left_id, right_id, score, note)
         VALUES ($1, $2, $3, 'customer', $4, $5, 0.912, $6)`,
        [id, DEMO_IDS.tenantId, DEMO_IDS.companyId, leftId, rightId, note],
      );
    }

    const migration = (await loadMigrationFiles()).find((file) => file.id === MIGRATION_ID);
    expect(migration).toBeDefined();
    await db.database.exec(migration!.sql);

    const { rows } = await db.database.query<{
      id: string;
      matched_by: string;
      note: string | null;
    }>(
      `SELECT id::text AS id, matched_by, note
         FROM masterdata_dedupe
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[ids.withNote, ids.prefixOnly]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ids.withNote)).toMatchObject({ matched_by: 'name_phone', note: '同名不同规格' });
    expect(byId.get(ids.prefixOnly)).toMatchObject({ matched_by: 'name_only', note: null });

    // 没有备注的老行不该留一个空串。
    expect(byId.get(ids.prefixOnly)!.note).toBeNull();

    // 索引也建好了：审核台主查询靠它，缺了会退化成 Sort。
    const index = await db.database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'masterdata_dedupe_console_idx'`,
    );
    expect(index.rows).toHaveLength(1);
  });
});
