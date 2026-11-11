import { ROUTES } from '@qingdan/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig } from '../platform/config.js';
import {
  batchDirectoryPort,
  billingEntitlementPort,
  downstreamReferencePort,
  employeeDirectoryPort,
  processingLossAggregatePort,
  productDirectoryPort,
  salesReceiptPort,
  settlementDraftPort,
  settlementProfitAggregatePort,
  stockFlowPort,
} from '../platform/services/registry.js';

/**
 * 规则机械检查（2026-11-11 优化任务后补）。
 *
 * 这些规则写在 `.github/copilot-instructions.md` 里会被忽略，所以每条都要有个测试盯着：
 *   1. 业务模块之间的调用必须走 `platform/services/registry.ts` 的端口，且端口要真注册上；
 *   2. 契约注册表里的每个 operationId 必须出现在 `docs/api/openapi.yaml`（改了契约就得重生成）；
 *   3. 采购单 D15 的两条写入路径都必须调用 `assertProductsInCompany`，且测试覆盖跨公司商品；
 *   4. 每条新迁移要有对应的回归测试。
 */

const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/**
 * 端口必须全部真注册上。
 *
 * 「有意还没接线」的端口在这里显式登记原因；一旦有人把它接上，下面的双向断言会要求
 * 把这一行删掉，避免白名单变成永久豁免。
 */
const INTENTIONALLY_UNWIRED: Readonly<Record<string, string>> = {};

describe('规则机械检查', () => {
  const app = buildApp({ config: testConfig(), database: null });

  afterAll(async () => {
    await app.close();
  });

  it('D70：service port 全部真注册（未接线的必须在白名单里写明原因）', () => {
    const ports: ReadonlyArray<readonly [string, () => unknown]> = [
      ['stockFlowPort', stockFlowPort],
      ['settlementDraftPort', settlementDraftPort],
      ['employeeDirectoryPort', employeeDirectoryPort],
      ['salesReceiptPort', salesReceiptPort],
      ['billingEntitlementPort', billingEntitlementPort],
      ['downstreamReferencePort', downstreamReferencePort],
      ['settlementProfitAggregatePort', settlementProfitAggregatePort],
      ['processingLossAggregatePort', processingLossAggregatePort],
      ['productDirectoryPort', productDirectoryPort],
      ['batchDirectoryPort', batchDirectoryPort],
    ];

    const wired = new Map<string, boolean>();
    for (const [name, accessor] of ports) {
      try {
        accessor();
        wired.set(name, true);
      } catch {
        wired.set(name, false);
      }
    }

    const missing = ports
      .map(([name]) => name)
      .filter((name) => !wired.get(name) && !(name in INTENTIONALLY_UNWIRED));
    expect(missing, `这些端口没注册上：${missing.join('、')}`).toEqual([]);

    const nowWired = ports
      .map(([name]) => name)
      .filter((name) => wired.get(name) && name in INTENTIONALLY_UNWIRED);
    expect(
      nowWired,
      `这些端口已经接线了，请从 INTENTIONALLY_UNWIRED 删掉：${nowWired.join('、')}`,
    ).toEqual([]);
  });

  it('契约改动必须同步 OpenAPI：注册表里每个 operationId 都在说明书里', () => {
    const openapi = readRepoFile('docs/api/openapi.yaml');
    const operationIds = ROUTES.map((route) => route.operationId);
    const missing = operationIds.filter((id) => !openapi.includes(`operationId: ${id}`));
    expect(missing, `说明书缺少这些 operationId（跑 pnpm openapi 重生成）：${missing.join('、')}`).toEqual([]);
  });

  it('D15：采购单开单与改单都必须调用 assertProductsInCompany', () => {
    const source = readFileSync(path.join(API_SRC, 'modules/purchase/repo.ts'), 'utf8');
    // insertPurchaseOrder / updatePurchaseOrder 各至少一次：出现次数 >= 2 且至少一次在 update 分支附近。
    const calls = source.match(/assertProductsInCompany\(/g) ?? [];
    expect(calls.length, '采购单两条写入路径都要校验商品归属').toBeGreaterThanOrEqual(3); // 定义 + 两个调用
    expect(source).toMatch(/if \(input\.lines !== undefined\)[\s\S]{0,400}assertProductsInCompany\(/);
  });

  it('D15：采购单测试必须包含跨公司商品用例', () => {
    const testSource = readFileSync(
      path.join(API_SRC, 'modules/purchase/usecases/purchase-orders.test.ts'),
      'utf8',
    );
    expect(testSource).toContain('PRODUCT_OTHER_COMPANY_ID');
    expect(testSource).toMatch(/D15：开单 \/ 改单引用他公司商品/);
  });

  it('迁移必须有回归测试：0026 / 0027 在测试里被引用', () => {
    const backfillTest = readFileSync(
      path.join(API_SRC, 'platform/db/migrate-settled-at-backfill.test.ts'),
      'utf8',
    );
    expect(backfillTest).toContain('0026_settlement_orders_settled_at.sql');

    const dbGuardTest = readFileSync(
      path.join(API_SRC, 'modules/purchase/purchase-line-db-guard.test.ts'),
      'utf8',
    );
    expect(dbGuardTest).toMatch(/0027/);
  });
});
