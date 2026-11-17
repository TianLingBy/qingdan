import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { seed } from '../../platform/db/seed.js';
import type { SendLoginCodeInput, SmsSender } from '../../platform/sms/tencent.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { hashLoginCode } from './usecases/send-code.js';

/**
 * 登录验证码（D59③）：发码 → 真实码登录 → 一次性 / 过期 / 次数上限 / 频控。
 *
 * 分两套 app：
 *   - dev（非生产）：不发短信，固定 `LOGIN_DEV_CODE` 直通；
 *   - production：必须走库里的一次性验证码，短信发送器用假实现记录下发的码。
 */

const DEV_PHONE = '10000000001';
const PROD_PHONE = '10000000002';
const LOCKED_PHONE = '10000000003';
const LIMIT_PHONE = '10000000004';
const REQUEST_ID = 'req-login-code-0001';

describe('登录验证码', () => {
  let test: TestDatabase;
  let devApp: FastifyInstance;
  let prodApp: FastifyInstance;
  let unconfiguredApp: FastifyInstance;
  const sent: SendLoginCodeInput[] = [];
  const fakeSms: SmsSender = {
    async sendLoginCode(input) {
      sent.push(input);
    },
  };

  const sendCode = (app: FastifyInstance, phone: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/code',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { phone },
    });

  const login = (app: FastifyInstance, phone: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { phone, code },
    });

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    devApp = buildApp({
      config: testConfig(),
      database: test.database,
      requestIdFactory: () => REQUEST_ID,
    });
    prodApp = buildApp({
      config: testConfig({ nodeEnv: 'production' }),
      database: test.database,
      smsSender: fakeSms,
      requestIdFactory: () => REQUEST_ID,
    });
    unconfiguredApp = buildApp({
      config: testConfig({ nodeEnv: 'production' }),
      database: test.database,
      requestIdFactory: () => REQUEST_ID,
    });
    await Promise.all([devApp.ready(), prodApp.ready(), unconfiguredApp.ready()]);
  });

  afterAll(async () => {
    await Promise.all([devApp.close(), prodApp.close(), unconfiguredApp.close()]);
    await test.database.close();
  });

  it('非生产：发码 200 但不调用短信通道，固定码直接登录', async () => {
    const response = await sendCode(devApp, DEV_PHONE);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sent: true });
    expect(sent).toHaveLength(0);

    const logged = await login(devApp, DEV_PHONE, '000000');
    expect(logged.statusCode).toBe(200);
  });

  it('同号 60 秒内重复发码 → 429 RATE_LIMITED', async () => {
    const response = await sendCode(devApp, DEV_PHONE);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('production：短信通道收到 6 位码，用该码登录成功且只能用一次', async () => {
    const response = await sendCode(prodApp, PROD_PHONE);
    expect(response.statusCode).toBe(200);

    const last = sent.at(-1);
    expect(last?.phone).toBe(PROD_PHONE);
    expect(last?.code).toMatch(/^\d{6}$/);
    expect(last?.expiresMinutes).toBe(5);

    const first = await login(prodApp, PROD_PHONE, last!.code);
    expect(first.statusCode).toBe(200);

    const replay = await login(prodApp, PROD_PHONE, last!.code);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('production：连续错 5 次后，正确的码也失效（统一 401）', async () => {
    const response = await sendCode(prodApp, LOCKED_PHONE);
    expect(response.statusCode).toBe(200);
    const code = sent.at(-1)!.code;

    for (let i = 0; i < 5; i += 1) {
      const wrong = await login(prodApp, LOCKED_PHONE, '999999' === code ? '000001' : '999999');
      expect(wrong.statusCode).toBe(401);
    }

    const blocked = await login(prodApp, LOCKED_PHONE, code);
    expect(blocked.statusCode).toBe(401);
  });

  it('production 未配置短信 → 发码 501 NOT_IMPLEMENTED（明确说未配置）', async () => {
    const response = await sendCode(unconfiguredApp, '10000000009');
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('同一号码 24 小时累计 10 条后拒绝（每日上限）', async () => {
    for (let i = 0; i < 10; i += 1) {
      await test.database.query(
        `INSERT INTO login_code (id, phone, purpose, code_hash, expires_at, created_at)
         VALUES (gen_random_uuid(), $1, 'login', $2, now() + interval '1 minute', now() - interval '2 minutes')`,
        [LIMIT_PHONE, hashLoginCode(LIMIT_PHONE, '123456', 'test-pepper')],
      );
    }

    const response = await sendCode(devApp, LIMIT_PHONE);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
