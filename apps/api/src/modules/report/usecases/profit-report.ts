import {
  AppError,
  allowsScope,
  ProfitReportQuerySchema,
  type ProfitLossList,
  type ProfitReport,
  type ProfitReportQuery,
} from '@qingdan/contracts';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../../platform/auth/principal.js';
import { withTenant } from '../../../platform/auth/tenant-context.js';
import type { Database, SqlClient } from '../../../platform/db/client.js';
import {
  processingLossAggregatePort,
  settlementProfitAggregatePort,
  type ProcessingLossAggregateSource,
  type ProfitAggregateQuery,
  type SettlementProfitAggregateSource,
} from '../../../platform/services/registry.js';

export interface ProfitReportContext {
  readonly database: Database | null;
  readonly request: FastifyRequest;
}

export interface ProfitReportPorts {
  readonly settlement: SettlementProfitAggregateSource;
  readonly processing: ProcessingLossAggregateSource;
}

const DECIMAL_RE = /^-?\d{1,12}(\.\d{1,6})?$/;
const SCALE = 6n;
const SCALE_FACTOR = 10n ** SCALE;

function parseQuery(request: FastifyRequest): ProfitReportQuery {
  const raw = request.query as Record<string, unknown>;
  const normalized =
    typeof raw.companyIds === 'string'
      ? { ...raw, companyIds: [raw.companyIds] }
      : raw;
  const parsed = ProfitReportQuerySchema.safeParse(normalized);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', '利润报表查询参数不合法', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  if (parsed.data.periodStart > parsed.data.periodEnd) {
    throw new AppError('VALIDATION_FAILED', 'periodStart 不能晚于 periodEnd', {
      field: 'periodStart',
    });
  }
  return parsed.data;
}

function requireContext(ctx: ProfitReportContext): {
  principal: Principal;
  database: Database;
} {
  const principal = ctx.request.principal;
  if (!principal) throw new AppError('UNAUTHENTICATED');
  if (!ctx.database) {
    throw new AppError('NOT_IMPLEMENTED', '利润报表数据库未配置', {
      operationId: 'profit_report.read',
    });
  }
  return { principal, database: ctx.database };
}

function effectiveCompanyIds(
  principal: Principal,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested === undefined) return principal.companyIds;
  const allowed = new Set(principal.companyIds);
  const denied = requested.filter((id) => !allowed.has(id));
  if (denied.length > 0) {
    throw new AppError('FORBIDDEN', '不能查询当前身份不可见的公司', {
      companyIds: denied,
    });
  }
  return [...new Set(requested)];
}

function aggregateQuery(
  principal: Principal,
  query: ProfitReportQuery,
): ProfitAggregateQuery {
  return {
    tenantId: principal.tenantId,
    companyIds: effectiveCompanyIds(principal, query.companyIds),
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
  };
}

function scaled(value: string): bigint {
  const matched = DECIMAL_RE.exec(value.trim());
  if (!matched) throw new AppError('INTERNAL_ERROR', '聚合端口返回了非法 decimal');
  const text = value.trim();
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [integer = '0', fraction = ''] = body.split('.');
  const amount = BigInt(integer) * SCALE_FACTOR + BigInt(fraction.padEnd(6, '0'));
  return negative ? -amount : amount;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integer = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function subtractDecimal(left: string, right: string): string {
  return decimal(scaled(left) - scaled(right));
}

function canViewPrice(principal: Principal): boolean {
  return allowsScope(principal.scope, 'profit_report', 'view_price');
}

function defaultPorts(): ProfitReportPorts {
  return {
    settlement: settlementProfitAggregatePort(),
    processing: processingLossAggregatePort(),
  };
}

export async function getProfitReport(
  ctx: ProfitReportContext,
  ports: ProfitReportPorts = defaultPorts(),
): Promise<ProfitReport> {
  const { principal, database } = requireContext(ctx);
  const query = parseQuery(ctx.request);
  const aggregate = aggregateQuery(principal, query);
  const result = await withTenant(database, principal.tenantId, async (tx: SqlClient) => {
    const settlement = await ports.settlement.aggregateSettledProfit(tx, aggregate);
    const processing = await ports.processing.aggregateFullLoss(tx, aggregate);
    return { settlement, processing };
  });
  const netProfit = subtractDecimal(
    result.settlement.grossProfit,
    result.processing.lossAmount,
  );
  const visible = canViewPrice(principal);
  return {
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    grossProfit: visible ? result.settlement.grossProfit : null,
    fullLossAmount: visible ? result.processing.lossAmount : null,
    netProfit: visible ? netProfit : null,
    unattributedLoss: null,
    unattributedLossAvailable: false,
    settledOrderCount: result.settlement.settledOrderCount,
  };
}

export async function listProfitLosses(
  ctx: ProfitReportContext,
  ports: ProfitReportPorts = defaultPorts(),
): Promise<ProfitLossList> {
  const { principal, database } = requireContext(ctx);
  const query = parseQuery(ctx.request);
  const aggregate = aggregateQuery(principal, query);
  const processing = await withTenant(database, principal.tenantId, (tx: SqlClient) =>
    ports.processing.aggregateFullLoss(tx, aggregate),
  );
  const visible = canViewPrice(principal);
  return {
    items: processing.orders.map((order) => ({
      processingOrderId: order.processingOrderId,
      processingOrderNo: order.processingOrderNo,
      lossAmount: visible ? order.lossAmount : null,
      attributed: order.attributed,
    })),
  };
}
