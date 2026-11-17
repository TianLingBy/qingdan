import { readFileSync } from 'node:fs';
import type { CustomerContact, CustomerSummary, SalesOrder } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 多对接人 + 单据对接人引用 + 档案汇总（#306 / 设计文档 §十一、§十二）。
 *
 * 这份文件把 issue 列出的七个用例逐个落成断言：
 *   1. 主对接人唯一 → 409 `STATE_CONFLICT`（不是 422：请求本身合法，是档案状态冲突）；
 *   2. 开单传别家客户的 `contactId` → 422；
 *   3. 开单传别的公司的 `contactId` → 422；
 *   4. 无 `customer.view_price` 的 principal 调 summary → 响应体里**根本没有** `totalAmount` 键；
 *   5. 存量回填幂等：把迁移里的回填语句连跑两次，对接人数量不变；
 *   6. summary 只统计本公司单据（另一家公司的同客户单不计入）；
 *   7. 软停用（DELETE）后单据引用仍可读：`GET /sales-orders/{id}` 仍回对接人 id 与姓名。
 *
 * 另外顺带覆盖：列表手机号脱敏（只回 `phoneMasked`）、主对接人同步档案老字段
 * （`contact_name` / `contact_phone`，兼容旧读端）。
 */

const PUBLIC_BASE_URL = 'https://qingdan.example';
const OWNER_PHONE = '10000000001';
/** 「销售」岗位：持 customer.read / create / update，**不持** customer.view_price。 */
const SALES_PHONE = '10000000003';

const COMPANY2_ID = '01900000-0000-7000-8000-000000000003';
const SALES_POSITION_ID = '01900000-0000-7000-8000-000000000013';

const CUSTOMER_A_ID = '01900000-0000-7000-8000-000000005101';
const CUSTOMER_B_ID = '01900000-0000-7000-8000-000000005102';
const PRODUCT_ID = '01900000-0000-7000-8000-000000005111';
const BATCH_A_ID = '01900000-0000-7000-8000-000000005121';
const BATCH_B_ID = '01900000-0000-7000-8000-000000005122';

const LINE = {
  productId: PRODUCT_ID,
  batchIds: [BATCH_A_ID, BATCH_B_ID],
  qty: '2',
  unitPrice: '15',
  amount: '30',
};

const FEE = { feeName: '运费', qty: '1', unitPrice: '5', amount: '5', remark: null };

const MIGRATION_FILE = new URL(
  '../../../migrations/20261118060000_masterdata_contacts.sql',
  import.meta.url,
);

function readHeaders(cookie: string, requestId: string): Record<string, string> {
  return { cookie, 'x-request-id': requestId };
}

function writeHeaders(
  cookie: string,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extra };
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

/** 迁移文件里的回填语句（只取 INSERT，用于幂等复跑）。 */
function backfillStatements(): string[] {
  return readFileSync(MIGRATION_FILE, 'utf8')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => /INSERT INTO\s+customer_contact\b/i.test(statement));
}

describe('masterdata 对接人 + 汇总（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let salesCookie: string;

  let sequence = 0;
  function nextRequestId(prefix: string): string {
    sequence += 1;
    return `req-contact-${prefix}-${sequence}`;
  }

  async function createContact(
    customerId: string,
    payload: Record<string, unknown>,
    cookie = ownerCookie,
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customerId}/contacts`,
      headers: writeHeaders(cookie, nextRequestId('create')),
      payload,
    });
  }

  async function listContacts(customerId: string, cookie = ownerCookie) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customerId}/contacts`,
      headers: readHeaders(cookie, nextRequestId('list')),
    });
  }

  async function createOrder(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: writeHeaders(ownerCookie, nextRequestId('order')),
      payload: {
        companyId: DEMO_IDS.companyId,
        customerId: CUSTOMER_A_ID,
        handlerId: DEMO_IDS.ownerEmployeeId,
        lines: [LINE],
        fees: [FEE],
        ...payload,
      },
    });
  }

  async function summary(customerId: string, cookie: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customerId}/summary`,
      headers: readHeaders(cookie, nextRequestId('summary')),
    });
  }

  /** 带 `?groupBy=contact` 的汇总（与 `summary` 只差一个查询参数）。 */
  async function groupedSummary(customerId: string, cookie: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customerId}/summary?groupBy=contact`,
      headers: readHeaders(cookie, nextRequestId('summary-group')),
    });
  }

  const created: { contact: CustomerContact; order: SalesOrder } = {} as never;

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);

    // 第二家公司 + 只绑定该公司的员工（跨公司用例要用它持有公司2 的可见性）。
    await test.database.query(
      `INSERT INTO company (id, tenant_id, name, code, level, status)
       VALUES ($1, $2, '第二公司', '0002', 1, '启用')
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY2_ID, DEMO_IDS.tenantId],
    );

    await test.database.query(
      `INSERT INTO customer (id, tenant_id, company_id, customer_no, name)
       VALUES ($1, $2, $3, NULL, '对接人测试客户A'),
              ($4, $2, $3, NULL, '对接人测试客户B')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER_A_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId, CUSTOMER_B_ID],
    );
    await test.database.query(
      `INSERT INTO product
         (id, tenant_id, company_id, product_no, name, aliases, unit)
       VALUES ($1, $2, $3, NULL, '对接人测试商品', '{}', '件')
       ON CONFLICT (id) DO NOTHING`,
      [PRODUCT_ID, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    await test.database.query(
      `INSERT INTO inventory_batch
         (id, tenant_id, company_id, product_id, batch_no, locked_unit_cost,
          inbound_qty, referenced_qty, in_transit_qty, pending_execution_qty, custodian_id)
       VALUES ($1, $2, $3, $4, 'E-CONTACT-A', '10', '1000', '0', '0', '0', $5),
              ($6, $2, $3, $4, 'E-CONTACT-B', '20', '1000', '0', '0', '0', $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        BATCH_A_ID,
        DEMO_IDS.tenantId,
        DEMO_IDS.companyId,
        PRODUCT_ID,
        DEMO_IDS.ownerEmployeeId,
        BATCH_B_ID,
      ],
    );

    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-contact-login-owner');
    salesCookie = await login(app, SALES_PHONE, 'req-contact-login-sales');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('主对接人唯一：第二个 is_primary → 409 PRIMARY_EXISTS；列表脱敏、详情完整', async () => {
    const first = await createContact(CUSTOMER_A_ID, {
      name: '王经理',
      phone: '13800001111',
      title: '采购',
      isPrimary: true,
    });
    expect(first.statusCode).toBe(201);
    const contact = first.json() as CustomerContact;
    expect(contact.customerId).toBe(CUSTOMER_A_ID);
    expect(contact.isPrimary).toBe(true);
    // 详情（create / update 响应）回完整手机号。
    expect(contact.phone).toBe('13800001111');
    expect(first.headers.etag).toBe('"1"');

    // 再加一个非主对接人（列表里应当脱敏）。
    const second = await createContact(CUSTOMER_A_ID, { name: '李助理', phone: '13900002222' });
    expect(second.statusCode).toBe(201);

    // 选 409 而不是 422：请求本身合法，是「该档案已存在主对接人」这个状态冲突；
    // 422 只留给入参不合法（格式 / 跨越归属）。前端据 code 提示「先取消原主对接人」。
    const conflict = await createContact(CUSTOMER_A_ID, {
      name: '赵经理',
      phone: '13700003333',
      isPrimary: true,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'PRIMARY_EXISTS' },
    });

    // 同一档案下重名 → 409（走唯一约束翻译）。
    const duplicate = await createContact(CUSTOMER_A_ID, { name: '王经理' });
    expect(duplicate.statusCode).toBe(409);

    const list = await listContacts(CUSTOMER_A_ID);
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]?.phoneMasked).toBe('138****1111');
    expect('phone' in items[0]!).toBe(false);
    expect(items[0]?.isPrimary).toBe(true);

    // 主对接人同步档案老字段（兼容旧读端）。
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${CUSTOMER_A_ID}`,
      headers: readHeaders(ownerCookie, nextRequestId('customer-detail')),
    });
    expect(detail.json()).toMatchObject({
      contactName: '王经理',
      contactPhone: '13800001111',
    });

    created.contact = contact;
  });

  it('开单传别家客户的对接人 → 422', async () => {
    const foreign = await createContact(CUSTOMER_B_ID, { name: '别家对接人' });
    expect(foreign.statusCode).toBe(201);
    const foreignContact = foreign.json() as CustomerContact;

    const response = await createOrder({
      customerId: CUSTOMER_A_ID,
      customerContactId: foreignContact.id,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'customerContactId' },
    });
  });

  it('开单传别的公司的对接人 → 422', async () => {
    // 直插一条「同客户、但归属公司2」的对接人：正常 API 造不出来（用例会先挡住），
    // 这里要验的正是「归属公司不一致」这条 422 分支。
    const crossCompanyId = '01900000-0000-7000-8000-000000005901';
    await test.database.query(
      `INSERT INTO customer_contact
         (id, tenant_id, company_id, customer_id, name, phone, is_primary, status)
       VALUES ($1, $2, $3, $4, '跨公司对接人', NULL, false, '启用')
       ON CONFLICT DO NOTHING`,
      [crossCompanyId, DEMO_IDS.tenantId, COMPANY2_ID, CUSTOMER_A_ID],
    );

    const response = await createOrder({ customerContactId: crossCompanyId });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'customerContactId' },
    });
  });

  it('开单落对接人；summary 有 view_price 回金额、无 view_price 时键不出现', async () => {
    const order = await createOrder({ customerContactId: created.contact.id });
    expect(order.statusCode).toBe(201);
    const body = order.json() as SalesOrder;
    expect(body.customerContactId).toBe(created.contact.id);
    expect(body.customerContactName).toBe('王经理');
    created.order = body;

    // 老板持 customer.view_price → 金额字段在。
    const withPrice = await summary(CUSTOMER_A_ID, ownerCookie);
    expect(withPrice.statusCode).toBe(200);
    const full = withPrice.json() as CustomerSummary;
    expect(full.orderCount).toBe(1);
    expect(full.totalAmount).toBe('35');
    expect(full.contacts).toHaveLength(2);
    expect(full.contacts[0]?.phone).toBe('13800001111');
    // 最近单据要能说出「这一单是谁跟的」（#307 详情页的对接人列）。
    expect(full.recentOrders).toHaveLength(1);
    expect(full.recentOrders[0]?.contactId).toBe(created.contact.id);
    expect(full.recentOrders[0]?.contactName).toBe('王经理');

    // 销售不持 customer.view_price → **键根本没有**（不是 null、不是 0）。
    const noPrice = await summary(CUSTOMER_A_ID, salesCookie);
    expect(noPrice.statusCode).toBe(200);
    const masked = noPrice.json() as Record<string, unknown>;
    expect('totalAmount' in masked).toBe(false);
    expect(masked.orderCount).toBe(1);
    const recent = masked.recentOrders as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect('totalAmount' in recent[0]!).toBe(false);
    // 对接人不是金额，不持 view_price 也照常给——详情页要显示「谁跟的单」。
    expect(recent[0]?.contactId).toBe(created.contact.id);
    expect(recent[0]?.contactName).toBe('王经理');
  });

  it('summary 不统计跨子公司单据', async () => {
    // 同一客户、同一租户，但单据挂在公司2：不属于本公司，不能被计入。
    await test.database.query(
      `INSERT INTO sales_order
         (id, tenant_id, company_id, order_no, customer_id, handler_id, status,
          goods_amount, fee_amount, total_amount)
       VALUES ($1, $2, $3, 'E-XXXX-20261118-0001', $4, $5, '进行中', '100', '0', '100')
       ON CONFLICT DO NOTHING`,
      [
        '01900000-0000-7000-8000-000000005801',
        DEMO_IDS.tenantId,
        COMPANY2_ID,
        CUSTOMER_A_ID,
        DEMO_IDS.ownerEmployeeId,
      ],
    );

    const response = await summary(CUSTOMER_A_ID, ownerCookie);
    const body = response.json() as CustomerSummary;
    expect(body.orderCount).toBe(1);
    expect(body.totalAmount).toBe('35');
    expect(body.recentOrders).toHaveLength(1);
    expect(body.recentOrders[0]?.id).toBe(created.order.id);
  });

  it('groupBy=contact：按对接人分组、无对接人的单单独成组、分项之和等于总数', async () => {
    // 再造一张**不带对接人**的单：它必须出现在 contactId: null 那一组里。
    // 如果把这组过滤掉，各分组的 orderCount 加起来就小于 orderCount 总数——
    // 而「拿分项核对总数」正是分组的唯一用途。
    const plain = await createOrder();
    expect(plain.statusCode).toBe(201);

    const response = await groupedSummary(CUSTOMER_A_ID, ownerCookie);
    expect(response.statusCode).toBe(200);
    const body = response.json() as CustomerSummary;
    const groups = body.contactGroups;
    expect(groups).toBeDefined();
    expect(body.orderCount).toBe(2);

    // 分项之和 === 总数（这条比任何单点断言都重要）。
    expect(groups!.reduce((sum, group) => sum + group.orderCount, 0)).toBe(body.orderCount);

    const withContact = groups!.find((group) => group.contactId === created.contact.id);
    expect(withContact?.contactName).toBe('王经理');
    expect(withContact?.orderCount).toBe(1);

    const orphan = groups!.find((group) => group.contactId === null);
    expect(orphan).toBeDefined();
    expect(orphan?.orderCount).toBe(1);
    expect(orphan?.contactName).toBeNull();

    // 有对接人的那组金额是 35，无对接人那组也是 35（两张单同价）。
    expect(withContact?.totalAmount).toBe('35');
  });

  it('不带 groupBy 时没有 contactGroups 键；无 view_price 时分组金额键不出现', async () => {
    const plain = await summary(CUSTOMER_A_ID, ownerCookie);
    expect(plain.statusCode).toBe(200);
    // 「这次没问」与「数据可能没有」是两件事：不分组时键不该存在。
    expect('contactGroups' in (plain.json() as Record<string, unknown>)).toBe(false);

    const masked = await groupedSummary(CUSTOMER_A_ID, salesCookie);
    expect(masked.statusCode).toBe(200);
    const body = masked.json() as Record<string, unknown>;
    expect('totalAmount' in body).toBe(false);
    const groups = body.contactGroups as Array<Record<string, unknown>>;
    expect(groups.length).toBeGreaterThan(0);
    expect('totalAmount' in groups[0]!).toBe(false);
    // 对接人与笔数不是金额，照常给。
    expect(groups[0]?.orderCount).toBeDefined();
    expect('contactId' in groups[0]!).toBe(true);
  });

  it('groupBy 传非法值 → 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${CUSTOMER_A_ID}/summary?groupBy=product`,
      headers: readHeaders(ownerCookie, nextRequestId('summary-bad-group')),
    });
    expect(response.statusCode).toBe(422);
    // 错误体是扁平的 `{ code, message, details, requestId }`，不是 `{ error: {...} }`。
    const body = response.json() as { code: string; details: { issues: unknown[] } };
    expect(body.code).toBe('VALIDATION_FAILED');
  });


  it('回填幂等：迁移里的回填语句连跑两次，对接人数量不变', async () => {
    const legacyCustomerId = '01900000-0000-7000-8000-000000005201';
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, contact_name, contact_phone)
       VALUES ($1, $2, $3, NULL, '老档案客户', '老联系人', '13600009999')
       ON CONFLICT (id) DO NOTHING`,
      [legacyCustomerId, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );
    // 空名字的老档案：回填必须跳过，不能造出一条没有名字的对接人。
    const blankCustomerId = '01900000-0000-7000-8000-000000005202';
    await test.database.query(
      `INSERT INTO customer
         (id, tenant_id, company_id, customer_no, name, contact_name, contact_phone)
       VALUES ($1, $2, $3, NULL, '空联系人客户', '   ', '13600008888')
       ON CONFLICT (id) DO NOTHING`,
      [blankCustomerId, DEMO_IDS.tenantId, DEMO_IDS.companyId],
    );

    const statements = backfillStatements();
    expect(statements).toHaveLength(1);
    const countOf = async (): Promise<number> => {
      const result = await test.database.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM customer_contact
          WHERE customer_id = $1::uuid OR customer_id = $2::uuid`,
        [legacyCustomerId, blankCustomerId],
      );
      return result.rows[0]!.n;
    };

    await test.database.query(statements[0]!);
    const afterFirst = await countOf();
    await test.database.query(statements[0]!);
    const afterSecond = await countOf();

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(afterFirst);

    const backfilled = await test.database.query<{ name: string; phone: string; is_primary: boolean }>(
      `SELECT name, phone, is_primary FROM customer_contact WHERE customer_id = $1::uuid`,
      [legacyCustomerId],
    );
    expect(backfilled.rows[0]).toMatchObject({
      name: '老联系人',
      phone: '13600009999',
      is_primary: true,
    });
  });

  it('软停用（DELETE）后单据引用仍可读', async () => {
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer-contacts/${created.contact.id}`,
      headers: writeHeaders(ownerCookie, nextRequestId('delete'), { 'if-match': '"1"' }),
    });
    expect(deleted.statusCode).toBe(200);
    const stopped = deleted.json() as CustomerContact;
    expect(stopped.status).toBe('停用');
    // 行还在：不是物理删。
    const stillThere = await test.database.query<{ status: string }>(
      `SELECT status FROM customer_contact WHERE id = $1::uuid`,
      [created.contact.id],
    );
    expect(stillThere.rows[0]?.status).toBe('停用');

    const order = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/${created.order.id}`,
      headers: readHeaders(ownerCookie, nextRequestId('order-detail')),
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({
      customerContactId: created.contact.id,
      customerContactName: '王经理',
    });
  });
});
