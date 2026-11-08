import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { withTenant } from '../../platform/auth/tenant-context.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { billingEntitlementPort } from '../../platform/services/registry.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * 订阅读端点 + 平台端口（billing.subscription.read）。
 *
 *   - `expires_at = NULL` → 永久：daysRemaining null、dueSoon false；
 *   - 到期日在 30 天内 → dueSoon true，daysRemaining 按自然日计算；
 *   - 已过期 → daysRemaining 为负数；
 *   - 平台端口返回 { plan, expiresAt, expired, dueSoon }，一期只查询、不拦请求。
 */

const OWNER_PHONE = '10000000001';
/** 非老板（经理岗位）账号：种子里没有 billing 域权限，用于 403 用例。 */
const MANAGER_PHONE = '10000000002';
const REQUEST_ID = 'req-billing-subscription';

interface SubscriptionBody {
  companyId: string;
  plan: string;
  expiresAt: string | null;
  status: string;
  daysRemaining: number | null;
  dueSoon: boolean;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日历日偏移 → `YYYY-MM-DD`（与用例的「今天」口径一致）。 */
function isoDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

describe('platform 订阅读端点（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let cookie: string;

  async function loginWith(phone: string, requestId: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': requestId },
      payload: { phone, code: '000000' },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers['set-cookie']).split(';')[0]!;
  }

  function login(): Promise<string> {
    return loginWith(OWNER_PHONE, `${REQUEST_ID}-login`);
  }

  function getSubscription() {
    return app.inject({
      method: 'GET',
      url: '/api/v1/billing/subscription',
      headers: { cookie, 'x-request-id': REQUEST_ID },
    });
  }

  interface PatchOptions {
    readonly cookie?: string;
    /** undefined = 默认原因；null = 故意不带 X-Reason。 */
    readonly reason?: string | null;
    readonly requestId?: string;
  }

  function patchSubscription(payload: Record<string, unknown>, options: PatchOptions = {}) {
    const headers: Record<string, string> = {
      cookie: options.cookie ?? cookie,
      // Cookie 认证的 PATCH 必须同源（CSRF，D59⑧），与 testConfig 的 publicBaseUrl 对齐。
      origin: 'https://qingdan.example',
      'x-request-id': options.requestId ?? `${REQUEST_ID}-update`,
    };
    if (options.reason !== null) {
      headers['x-reason'] = options.reason ?? '运营调整订阅';
    }
    return app.inject({
      method: 'PATCH',
      url: '/api/v1/billing/subscription',
      headers,
      payload,
    });
  }

  async function successUpdateAuditCount(): Promise<number> {
    const result = await test.database.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_log
        WHERE action = 'billing.subscription.update' AND result = 'success'`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function setExpiry(value: string | null): Promise<void> {
    await test.database.query('UPDATE company SET expires_at = $1 WHERE id = $2', [
      value,
      DEMO_IDS.companyId,
    ]);
  }

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: 'https://qingdan.example' }),
      database: test.database,
      requestIdFactory: () => REQUEST_ID,
    });
    await app.ready();
    cookie = await login();
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('默认种子公司：expires_at 为 NULL → 永久，daysRemaining null、dueSoon false', async () => {
    await setExpiry(null);

    const response = await getSubscription();
    expect(response.statusCode).toBe(200);

    const body = response.json() as SubscriptionBody;
    expect(body).toMatchObject({
      companyId: DEMO_IDS.companyId,
      status: '启用',
      expiresAt: null,
      daysRemaining: null,
      dueSoon: false,
    });
    expect(body.plan).toBeTypeOf('string');
    expect(body.plan.length).toBeGreaterThan(0);
  });

  it('今天 +3 天到期：dueSoon true，daysRemaining 在 1..3', async () => {
    const expiry = isoDateOffset(3);
    await setExpiry(expiry);

    const response = await getSubscription();
    expect(response.statusCode).toBe(200);

    const body = response.json() as SubscriptionBody;
    expect(body.expiresAt).toBe(expiry);
    expect(body.daysRemaining).not.toBeNull();
    expect(body.daysRemaining!).toBeGreaterThanOrEqual(1);
    expect(body.daysRemaining!).toBeLessThanOrEqual(3);
    expect(body.dueSoon).toBe(true);
  });

  it('昨天到期：daysRemaining 为负数', async () => {
    await setExpiry(isoDateOffset(-1));

    const response = await getSubscription();
    expect(response.statusCode).toBe(200);

    const body = response.json() as SubscriptionBody;
    expect(body.daysRemaining).not.toBeNull();
    expect(body.daysRemaining!).toBeLessThan(0);
  });

  it('平台端口已注册，返回 { plan, expiresAt, expired, dueSoon }', async () => {
    const expiry = isoDateOffset(-1);
    await setExpiry(expiry);

    const entitlement = await withTenant(test.database, DEMO_IDS.tenantId, (tx) =>
      billingEntitlementPort().getEntitlement(tx, { companyId: DEMO_IDS.companyId }),
    );

    expect(entitlement.plan).toBeTypeOf('string');
    expect(entitlement.plan.length).toBeGreaterThan(0);
    expect(entitlement.expiresAt).toBe(expiry);
    expect(entitlement.expired).toBe(true);
    expect(entitlement.dueSoon).toBe(true);
  });

  it('调整套餐成功：PATCH 返回新套餐，GET 读到，audit_log 新增 1 条', async () => {
    await setExpiry(null);
    const before = await successUpdateAuditCount();
    const requestId = `${REQUEST_ID}-plan`;

    const response = await patchSubscription(
      { plan: '专业版' },
      { reason: '客户升级套餐', requestId },
    );
    expect(response.statusCode).toBe(200);

    const body = response.json() as SubscriptionBody;
    expect(body).toMatchObject({
      companyId: DEMO_IDS.companyId,
      plan: '专业版',
      expiresAt: null,
      daysRemaining: null,
      dueSoon: false,
    });

    const read = await getSubscription();
    expect(read.statusCode).toBe(200);
    expect((read.json() as SubscriptionBody).plan).toBe('专业版');

    expect(await successUpdateAuditCount()).toBe(before + 1);
    const audit = await test.database.query<{
      reason: string | null;
      object_type: string;
      object_id: string;
    }>(
      `SELECT reason, object_type, object_id FROM audit_log
        WHERE action = 'billing.subscription.update' AND request_id = $1`,
      [requestId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      reason: '客户升级套餐',
      object_type: 'company',
      object_id: DEMO_IDS.companyId,
    });
  });

  it('expiresAt 传 null 表示永久：daysRemaining 变 null、dueSoon false', async () => {
    await setExpiry(isoDateOffset(3));

    const response = await patchSubscription(
      { expiresAt: null },
      { reason: '改为永久授权', requestId: `${REQUEST_ID}-permanent` },
    );
    expect(response.statusCode).toBe(200);

    const body = response.json() as SubscriptionBody;
    expect(body.expiresAt).toBeNull();
    expect(body.daysRemaining).toBeNull();
    expect(body.dueSoon).toBe(false);

    const read = (await getSubscription()).json() as SubscriptionBody;
    expect(read.expiresAt).toBeNull();
    expect(read.daysRemaining).toBeNull();
    expect(read.dueSoon).toBe(false);
  });

  it('没有 billing.update 权限的非老板账号 → 403', async () => {
    const managerCookie = await loginWith(MANAGER_PHONE, `${REQUEST_ID}-manager-login`);

    const response = await patchSubscription(
      { plan: '专业版' },
      { cookie: managerCookie, reason: '尝试调整', requestId: `${REQUEST_ID}-manager` },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('缺 X-Reason → 400，且订阅保持不变', async () => {
    const before = (await getSubscription()).json() as SubscriptionBody;

    const response = await patchSubscription(
      { plan: '不应生效' },
      { reason: null, requestId: `${REQUEST_ID}-no-reason` },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const after = (await getSubscription()).json() as SubscriptionBody;
    expect(after.plan).toBe(before.plan);
  });
});
