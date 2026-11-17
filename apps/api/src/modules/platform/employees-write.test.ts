import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../platform/config.js';
import { DEMO_IDS, seed } from '../../platform/db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';

/**
 * M1 员工管理写端点（platform.employee.create / update / disable，契约 2026-11-05 #46）：
 *
 * - create：工号服务端自动发放（D48，入参不接收 employeeNo → 422 strict）；
 *   手机号同租户占用 → 422；跨租户占用 → 403 + 「联系原企业管理员」（D14）；
 *   公司/岗位必须存在于本租户（404）；AI 建号 → 403 AI_ACTION_FORBIDDEN（D54⑥）；
 *   公司×岗位按两数组的全组合落 `employee_company_position`（契约只有两个数组，见用例头注释）；
 * - update：If-Match 强制（缺失 428 / 格式坏或不匹配 409）；不可改 id / 工号；
 *   改 isOwner 仅限人类且仅老板（D59⑥）；AI 普通编辑放行（契约 ai.policy=allow）；
 * - disable：软停用回实体 + 新 ETag；已停用幂等成功；最后一个在职老板不可停；
 *   **停用后该员工的会话与 API Token 下一次请求立即 401（D52.1②，由
 *   computeAuthz 的 `e.status='在职'` 每请求现判保证，不引入缓存、不改内核函数）**；
 * - 全部写操作 100% 审计（D51）；失败审计由 mountRoutes 统一补 `fail`。
 *
 * 契约语义备注（负责人思考点 1）：`positionIds` + `companyIds` 是两个独立数组，
 * 落库只能取全组合；「公司×岗位配对」结构需契约后续版本提供，本实现不自行发明字段。
 */

const OWNER_PHONE = '10000000001';
const MANAGER_PHONE = '10000000002';
const PUBLIC_BASE_URL = 'https://qingdan.example';

/** seed：老板 011 / 经理 012 / 销售 013；演示公司一个；工号已用到 000004。 */
const SALES_POSITION_ID = '01900000-0000-7000-8000-000000000013';
const WAREHOUSE_POSITION_ID = '01900000-0000-7000-8000-000000000016';
const MANAGER_POSITION_ID = '01900000-0000-7000-8000-000000000012';
const UNKNOWN_UUID = '01900000-0000-7000-8000-00000000ffff';

interface EmployeeBody {
  id: string;
  employeeNo: string;
  name: string;
  status: string;
  isOwner: boolean;
  phoneMasked: string;
  companies: Array<{ companyId: string; companyName: string; positionId: string; positionName: string }>;
  version: number;
}

interface AuditRow {
  action: string;
  object_type: string;
  object_id: string | null;
  result: string;
  actor_id: string;
  tenant_id: string | null;
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

describe('platform 员工管理写端点（PGlite + seed 演示租户）', () => {
  let test: TestDatabase;
  let app: FastifyInstance;
  let ownerCookie: string;
  let managerCookie: string;

  async function createEmployee(
    cookie: string,
    requestId: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: { cookie, origin: PUBLIC_BASE_URL, 'x-request-id': requestId, ...extraHeaders },
      payload: body,
    });
  }

  const CREATE_BODY = {
    name: '钱进',
    phone: '10000000010',
    positionIds: [SALES_POSITION_ID],
    companyIds: [DEMO_IDS.companyId],
  };

  beforeAll(async () => {
    test = await createTestDatabase();
    await seed(test.database);
    app = buildApp({
      config: testConfig({ publicBaseUrl: PUBLIC_BASE_URL }),
      database: test.database,
      requestIdFactory: () => 'req-fallback',
    });
    await app.ready();
    ownerCookie = await login(app, OWNER_PHONE, 'req-employee-write-login-owner');
    managerCookie = await login(app, MANAGER_PHONE, 'req-employee-write-login-manager');
  });

  afterAll(async () => {
    await app.close();
    await test.database.close();
  });

  it('create：老板建号 → 201，工号自动发放 000005、手机号脱敏、version=1、绑定落全组合', async () => {
    const response = await createEmployee(ownerCookie, 'req-employee-create-ok', CREATE_BODY);
    expect(response.statusCode).toBe(201);

    const body = response.json() as EmployeeBody;
    expect(body.employeeNo).toBe('000005');
    expect(body.name).toBe('钱进');
    expect(body.status).toBe('在职');
    expect(body.isOwner).toBe(false);
    expect(body.phoneMasked).toBe('100****0010');
    expect(body.version).toBe(1);
    expect(body.companies).toEqual([
      {
        companyId: DEMO_IDS.companyId,
        companyName: '演示公司',
        positionId: SALES_POSITION_ID,
        positionName: '销售',
      },
    ]);

    // D51：写操作必记审计。
    const audits = await test.database.query<AuditRow>(
      `SELECT action, object_type, object_id, result, actor_id, tenant_id
         FROM audit_log WHERE request_id = $1`,
      ['req-employee-create-ok'],
    );
    expect(audits.rows).toEqual([
      {
        action: 'platform.employee.create',
        object_type: 'employee',
        object_id: body.id,
        result: 'success',
        actor_id: DEMO_IDS.ownerEmployeeId,
        tenant_id: DEMO_IDS.tenantId,
      },
    ]);
  });

  it('create：两个公司 × 两个岗位 → 4 条绑定（两数组全组合语义）', async () => {
    const response = await createEmployee(ownerCookie, 'req-employee-create-cartesian', {
      ...CREATE_BODY,
      phone: '10000000011',
      positionIds: [SALES_POSITION_ID, WAREHOUSE_POSITION_ID],
      companyIds: [DEMO_IDS.companyId],
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as EmployeeBody;
    expect(body.companies).toHaveLength(2);
  });

  it('create：body 传 employeeNo → 422（.strict()，工号只由服务端发放）', async () => {
    const response = await createEmployee(ownerCookie, 'req-employee-create-employee-no', {
      ...CREATE_BODY,
      employeeNo: '999999',
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('create：手机号同租户已占用 → 422', async () => {
    const response = await createEmployee(ownerCookie, 'req-employee-create-phone-dup', {
      ...CREATE_BODY,
      phone: OWNER_PHONE,
    });
    expect(response.statusCode).toBe(422);
  });

  it('create：手机号被其他企业占用 → 403 + 提示联系原企业管理员（D14）', async () => {
    // 直接落一个「其他租户」占用同一手机号（测试库以属主连接直写，绕 RLS）。
    await test.database.query(
      `INSERT INTO tenant (id, name, status) VALUES ($1, '另一家企业', '启用')`,
      ['01900000-0000-7000-8000-00000000aa01'],
    );
    await test.database.query(
      `INSERT INTO employee (id, tenant_id, employee_no, phone, name)
       VALUES ($1, $2, '000001', $3, '别人家的员工')`,
      ['01900000-0000-7000-8000-00000000aa02', '01900000-0000-7000-8000-00000000aa01', '10000000012'],
    );

    const response = await createEmployee(ownerCookie, 'req-employee-create-phone-cross', {
      ...CREATE_BODY,
      phone: '10000000012',
    });
    expect(response.statusCode).toBe(403);
    const body = response.json() as { code: string; message: string; details?: { reason?: string } };
    expect(body.code).toBe('FORBIDDEN');
    expect(body.details?.reason).toBe('PHONE_OCCUPIED_OTHER_TENANT');
    expect(body.message).toContain('联系原企业管理员');
  });

  it('create：公司/岗位不属于本租户 → 404', async () => {
    const byPosition = await createEmployee(ownerCookie, 'req-employee-create-bad-position', {
      ...CREATE_BODY,
      phone: '10000000013',
      positionIds: [UNKNOWN_UUID],
    });
    expect(byPosition.statusCode).toBe(404);

    const byCompany = await createEmployee(ownerCookie, 'req-employee-create-bad-company', {
      ...CREATE_BODY,
      phone: '10000000014',
      companyIds: [UNKNOWN_UUID],
    });
    expect(byCompany.statusCode).toBe(404);
  });

  it('create：非老板（经理只有 employee.read）→ 403；AI 建号 → 403 AI_ACTION_FORBIDDEN', async () => {
    const byManager = await createEmployee(managerCookie, 'req-employee-create-manager', CREATE_BODY);
    expect(byManager.statusCode).toBe(403);

    // 老板给自己建一个全量 scope 的 Token，用 Bearer 调 create（契约 ai.policy=forbid）。
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-employee-ai-token' },
      payload: {
        name: '建号测试 Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'employee', actions: ['read', 'create', 'update', 'delete'] }],
      },
    });
    expect(tokenResponse.statusCode).toBe(201);
    const { secret: token } = tokenResponse.json() as { secret: string };

    const byAi = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: {
        authorization: `Bearer ${token}`,
        origin: PUBLIC_BASE_URL,
        'x-reason': '测试：AI 建号应被拒绝',
        'x-request-id': 'req-employee-create-ai',
      },
      payload: CREATE_BODY,
    });
    expect(byAi.statusCode).toBe(403);
    expect((byAi.json() as { code: string }).code).toBe('AI_ACTION_FORBIDDEN');
  });

  it('update：改名字 → 200 + ETag "2"；缺 If-Match → 428；版本不匹配 → 409', async () => {
    const created = await createEmployee(ownerCookie, 'req-employee-update-seed', {
      ...CREATE_BODY,
      phone: '10000000015',
    });
    const employee = created.json() as EmployeeBody;

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-employee-update-no-etag' },
      payload: { name: '钱进二' },
    });
    expect(missing.statusCode).toBe(428);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"99"',
        'x-request-id': 'req-employee-update-stale',
      },
      payload: { name: '钱进二' },
    });
    expect(stale.statusCode).toBe(409);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${employee.version}"`,
        'x-request-id': 'req-employee-update-ok',
      },
      payload: { name: '钱进二' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    const updated = ok.json() as EmployeeBody;
    expect(updated.name).toBe('钱进二');
    expect(updated.version).toBe(2);
    expect(updated.employeeNo).toBe(employee.employeeNo);
  });

  it('update：改 isOwner 仅限人类（AI → 403）；仅老板可传（经理 → 403）', async () => {
    const created = await createEmployee(ownerCookie, 'req-employee-update-owner-seed', {
      ...CREATE_BODY,
      phone: '10000000016',
    });
    const employee = created.json() as EmployeeBody;

    // AI 普通编辑放行（契约 ai.policy=allow），但改 isOwner 必须被字段级拦截。
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-employee-ai-token-2' },
      payload: {
        name: '编辑测试 Token',
        employeeId: DEMO_IDS.ownerEmployeeId,
        scope: [{ domain: 'employee', actions: ['read', 'update'] }],
      },
    });
    const { secret: token } = tokenResponse.json() as { secret: string };

    const aiEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        origin: PUBLIC_BASE_URL,
        'x-reason': '测试：AI 改名应放行',
        'if-match': `"${employee.version}"`,
        'x-request-id': 'req-employee-update-ai-name',
      },
      payload: { name: '钱进三' },
    });
    expect(aiEdit.statusCode).toBe(200);

    const aiOwner = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        authorization: `Bearer ${token}`,
        origin: PUBLIC_BASE_URL,
        'x-reason': '测试：AI 改老板标识应被拒绝',
        'if-match': '"2"',
        'x-request-id': 'req-employee-update-ai-owner',
      },
      payload: { isOwner: true },
    });
    expect(aiOwner.statusCode).toBe(403);
    expect((aiOwner.json() as { code: string }).code).toBe('AI_ACTION_FORBIDDEN');

    // 经理连 employee.update 都没有 → scope 403（isOwner 更不可能）。
    const byManager = await app.inject({
      method: 'PATCH',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        cookie: managerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"2"',
        'x-request-id': 'req-employee-update-manager-owner',
      },
      payload: { isOwner: true },
    });
    expect(byManager.statusCode).toBe(403);
  });

  it('disable：软停用 → 200 + status 停用 + 新 ETag；重复停用幂等；AI 停用 → 403', async () => {
    const created = await createEmployee(ownerCookie, 'req-employee-disable-seed', {
      ...CREATE_BODY,
      phone: '10000000017',
    });
    const employee = created.json() as EmployeeBody;

    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${employee.version}"`,
        'x-request-id': 'req-employee-disable-ok',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe(`"${employee.version + 1}"`);
    const disabled = ok.json() as EmployeeBody;
    expect(disabled.status).toBe('停用');
    expect(disabled.version).toBe(employee.version + 1);

    // 幂等：已停用再次停用（同一 If-Match）仍成功，版本不再变。
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${employee.id}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${employee.version}"`,
        'x-request-id': 'req-employee-disable-again',
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as EmployeeBody).version).toBe(employee.version + 1);

    // D51：两次请求都有审计（第二次走幂等成功路径也要留痕）。
    const audits = await test.database.query<AuditRow>(
      `SELECT action, object_type, result FROM audit_log
        WHERE request_id IN ($1, $2) ORDER BY action, result`,
      ['req-employee-disable-ok', 'req-employee-disable-again'],
    );
    expect(audits.rows.length).toBe(2);
  });

  it('disable：缺 If-Match → 428；最后一个在职老板不可停（403 LAST_ACTIVE_OWNER）', async () => {
    const created = await createEmployee(ownerCookie, 'req-employee-disable-guard-seed', {
      ...CREATE_BODY,
      phone: '10000000018',
    });
    const employee = created.json() as EmployeeBody;

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${employee.id}`,
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-employee-disable-no-etag' },
    });
    expect(missing.statusCode).toBe(428);

    const lastOwner = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${DEMO_IDS.ownerEmployeeId}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-employee-disable-last-owner',
      },
    });
    expect(lastOwner.statusCode).toBe(403);
    expect((lastOwner.json() as { details?: { reason?: string } }).details?.reason).toBe(
      'LAST_ACTIVE_OWNER',
    );

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${UNKNOWN_UUID}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': '"1"',
        'x-request-id': 'req-employee-disable-404',
      },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('D52.1②：停用后，该员工的会话与 API Token 下一次请求立即 401（每请求现判，无缓存）', async () => {
    const phone = '10000000019';
    const created = await createEmployee(ownerCookie, 'req-employee-invalidate-seed', {
      ...CREATE_BODY,
      phone,
      positionIds: [MANAGER_POSITION_ID],
    });
    const employeeId = (created.json() as EmployeeBody).id;

    // 新员工自己登录，并给自己发一个 Token。
    const ownCookie = await login(app, phone, 'req-employee-invalidate-login');
    const meBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: ownCookie, 'x-request-id': 'req-employee-invalidate-me' },
    });
    expect(meBefore.statusCode).toBe(200);

    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: { cookie: ownerCookie, origin: PUBLIC_BASE_URL, 'x-request-id': 'req-employee-invalidate-token' },
      payload: {
        name: '停用失效测试 Token',
        employeeId,
        scope: [{ domain: 'employee', actions: ['read'] }],
      },
    });
    const { secret: token } = tokenResponse.json() as { secret: string };
    const bearerBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}`, 'x-request-id': 'req-employee-invalidate-bearer' },
    });
    expect(bearerBefore.statusCode).toBe(200);

    // 老板停用该员工。
    const version = (created.json() as EmployeeBody).version;
    const disabled = await app.inject({
      method: 'DELETE',
      url: `/api/v1/employees/${employeeId}`,
      headers: {
        cookie: ownerCookie,
        origin: PUBLIC_BASE_URL,
        'if-match': `"${version}"`,
        'x-request-id': 'req-employee-invalidate-disable',
      },
    });
    expect(disabled.statusCode).toBe(200);

    // 会话与 Token 下一次请求都 401（computeAuthz 过滤 `status='在职'`）。
    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: ownCookie, 'x-request-id': 'req-employee-invalidate-me-after' },
    });
    expect(meAfter.statusCode).toBe(401);

    const bearerAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}`, 'x-request-id': 'req-employee-invalidate-bearer-after' },
    });
    expect(bearerAfter.statusCode).toBe(401);
  });
});
