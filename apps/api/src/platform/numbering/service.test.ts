import { AppError } from '@qingdan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../testing/pglite.js';
import { documentScopeKey, takeDocumentNo, takeEmployeeNo } from './service.js';

const TENANT = '01900000-0000-7000-8000-0000000000f1';
const COMPANY = '01900000-0000-7000-8000-0000000000f2';
const COMPANY_42 = '01900000-0000-7000-8000-0000000000f3';
const NOV = new Date('2026-11-04T10:00:00Z');
const DEC = new Date('2026-12-01T00:00:01Z');

describe('取号服务（D16 / D48）', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await createTestDatabase();
    await test.database.transaction(async (tx) => {
      await tx.query(`INSERT INTO tenant (id, name, status) VALUES ($1, '取号租户', '启用')`, [TENANT]);
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '取号公司', '0001')`,
        [COMPANY, TENANT],
      );
      await tx.query(
        `INSERT INTO company (id, tenant_id, name, code) VALUES ($1, $2, '公司42', '0042')`,
        [COMPANY_42, TENANT],
      );
    });
  });

  afterAll(async () => {
    await test.database.close();
  });

  it('格式：类型字母-公司码(4)-日期(8)-流水(4)，同月递增', async () => {
    const first = await test.database.transaction((tx) => takeDocumentNo(tx, 'E', COMPANY, NOV));
    expect(first).toBe('E-0001-20261104-0001');

    const second = await test.database.transaction((tx) => takeDocumentNo(tx, 'E', COMPANY, NOV));
    expect(second).toBe('E-0001-20261104-0002');
  });

  it('流水按月重置（换键，不清表）', async () => {
    const december = await test.database.transaction((tx) => takeDocumentNo(tx, 'E', COMPANY, DEC));
    expect(december).toBe('E-0001-20261201-0001');
  });

  it('不同类型各自独立流水', async () => {
    const purchase = await test.database.transaction((tx) => takeDocumentNo(tx, 'A', COMPANY, NOV));
    expect(purchase).toBe('A-0001-20261104-0001');
  });

  it('公司码四位补零（0042 保持原样）', async () => {
    const no = await test.database.transaction((tx) => takeDocumentNo(tx, 'N', COMPANY_42, NOV));
    expect(no).toBe('N-0042-20261104-0001');
  });

  it('工号：6 位、租户级全局递增、不按月重置', async () => {
    const first = await test.database.transaction((tx) => takeEmployeeNo(tx, TENANT));
    const second = await test.database.transaction((tx) => takeEmployeeNo(tx, TENANT));
    expect(first).toBe('000001');
    expect(second).toBe('000002');
  });

  it('月流水用完 9999 → 显式失败（禁止回绕）', async () => {
    const scopeKey = documentScopeKey('B', NOV, COMPANY);
    await test.database.query(
      `INSERT INTO number_sequence (tenant_id, scope_key, last_value) VALUES ($1, $2, 9999)
       ON CONFLICT (tenant_id, scope_key) DO UPDATE SET last_value = 9999`,
      [TENANT, scopeKey],
    );

    await expect(
      test.database.transaction((tx) => takeDocumentNo(tx, 'B', COMPANY, NOV)),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      test.database.transaction((tx) => takeDocumentNo(tx, 'B', COMPANY, NOV)),
    ).rejects.toThrow(/9999/);
  });

  it('公司不存在 → NOT_FOUND', async () => {
    await expect(
      test.database.transaction((tx) =>
        takeDocumentNo(tx, 'E', '01900000-0000-7000-8000-00000000dead', NOV),
      ),
    ).rejects.toThrow(/公司不存在/);
  });

  it('租户不存在 → NOT_FOUND（工号）', async () => {
    await expect(
      test.database.transaction((tx) => takeEmployeeNo(tx, '01900000-0000-7000-8000-00000000beef')),
    ).rejects.toThrow(/租户不存在/);
  });

  it('取号键含公司：不同公司互不影响（D16 单公司月内 9999）', () => {
    const a = documentScopeKey('A', NOV, COMPANY);
    const b = documentScopeKey('A', NOV, '01900000-0000-7000-8000-0000000000aa');
    expect(a).not.toBe(b);
    expect(a).toContain('document:');
  });
});