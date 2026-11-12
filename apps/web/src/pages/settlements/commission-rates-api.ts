/**
 * 提成比例配置接口封装（22 页 IA 第 7 页的从属入口；D77 / D36 / D54）。
 *
 * 只有 3 条端点（契约 `packages/contracts/src/commission-rates.ts`）：
 * 列表 / 新增 / 删除。**没有修改端点**——改比例的正确做法是「换生效日新增一条」，
 * 或者删掉旧那条再加，服务端不给 update（历史已结算单靠快照冻结，D77 ④）。
 *
 * 口径（别在这里发明）：
 * - **一期只按人配置**（D77 ①）：`employeeId` 必填；按岗配置要等 platform 岗位解析端口，
 *   未落地前不在前端猜；
 * - **比例是 decimal 字符串 [0, 1]**（`0.05` = 5%，D54）：界面按**百分比**输入，
 *   换算走定点乘法，**不过 `Number()`**——`0.1 + 0.2` 那种浮点漂移会让财务对不上账；
 * - **同员工 + 同公司 + 同生效日唯一**，重复插入服务端回 409（**不是**版本冲突，
 *   配置行没有版本列）——文案必须说「已有配置」，不能借用单据那套「别人改过」；
 * - **删除按 id 幂等**：已删的回 404，语义是「别人先删了」，刷新即可；
 * - 配置直接决定钱：写操作服务端 `ai.policy = forbid`（D52①），前端也不做任何猜测补全。
 */

import type { CommissionRate, CommissionRateCreateInput } from '@qingdan/contracts';
import { ApiClient, ApiError, apiClient } from '../../api/client';
import { compareDecimal, multiplyDecimal } from '../../lib/decimal';
import { describeWriteError } from '../../lib/write-error';
import type { PageResult } from '../masterdata/masterdata-api';

/* ------------------------------ 接口 ------------------------------ */

export interface CommissionRateListFilters {
  readonly companyId?: string;
  readonly employeeId?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export function createCommissionRatesApi(client: ApiClient = apiClient) {
  return {
    list: (filters: CommissionRateListFilters = {}) =>
      client.get<PageResult<CommissionRate>>('/commission-rates', {
        query: {
          companyId: filters.companyId,
          employeeId: filters.employeeId,
          cursor: filters.cursor ?? undefined,
          limit: filters.limit ?? 50,
        },
      }),
    create: (input: CommissionRateCreateInput) =>
      client.post<CommissionRate>('/commission-rates', input),
    /** 删除一条配置：已删的回 404（幂等语义，D77）。 */
    remove: (id: string) => client.delete<CommissionRate>(`/commission-rates/${id}`),
  };
}

export type CommissionRatesApi = ReturnType<typeof createCommissionRatesApi>;
export const commissionRatesApi = createCommissionRatesApi();

export const commissionRateQueryKeys = {
  list: (filters: CommissionRateListFilters) =>
    ['commission-rates', 'list', filters] as const,
};

/* ------------------------------ 比例换算 ------------------------------ */

/**
 * 百分比输入格式：0–100，最多 4 位小数。
 *
 * 为什么是 4 位：契约里比例是 `numeric(18,6)`（D54），百分比 = 比例 × 100，
 * 所以百分比最多只能有 4 位小数，再多一位就落不到 6 位定点的格子里。
 */
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;

/**
 * 百分比文本 → 契约要的 decimal 字符串（`5` → `0.05`）。
 *
 * 非法（格式不对 / 超过 100% / 超过 4 位小数）一律返回 `null`，由调用方给提示——
 * **不要返回 `0` 或 `''`**，那会被当成合法值提交上去。
 */
export function percentToRate(percent: string): string | null {
  const text = percent.trim();
  if (!PERCENT_PATTERN.test(text)) return null;
  // 定点乘法：percent × 0.01。结果最多 6 位小数，正好落在契约的 scale 上。
  const rate = multiplyDecimal(text, '0.01');
  return compareDecimal(rate, '1') > 0 ? null : rate;
}

/**
 * 表格展示：`0.05` → `5.00%`、`0.123456` → `12.3456%`。
 *
 * 与详情页的 `formatCommissionRate` 的区别：那个固定 2 位小数（快照只用于展示），
 * 这里配置**可编辑**，截断会把 `0.123456` 显示成 `12.34%`，让人以为自己配错了，
 * 所以小数位按实际值给到 4 位、不足 2 位补 0。
 */
export function formatRatePercent(rate: string): string {
  const percent = multiplyDecimal(rate, '100');
  const negative = percent.startsWith('-');
  const body = negative ? percent.slice(1) : percent;
  const [integer = '0', fraction = ''] = body.split('.');
  let decimals = fraction;
  while (decimals.length > 2 && decimals.endsWith('0')) {
    decimals = decimals.slice(0, -1);
  }
  decimals = decimals.padEnd(2, '0');
  return `${negative ? '-' : ''}${integer}.${decimals}%`;
}

/**
 * 生效日回填默认值：今天（本地时区）。
 *
 * 不用 `toISOString()`——那是 UTC，晚上 8 点之后在东八区会回填成「昨天」，
 * 财务在晚上配比例会莫名其妙配到前一天。
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* ------------------------------ 报错文案 ------------------------------ */

/**
 * 提成配置写失败的文案。
 *
 * **不能直接复用 `describeWriteError`**：那里 409 一律说「这张单已被别人改过（版本过期）」，
 * 但配置行**没有版本列**，409 的真实含义是「同员工 + 公司 + 生效日已有配置」（D77 ①）。
 * 照着原话提示，财务会去「重新读取再保存」，然后永远撞同一堵墙。
 */
export function describeCommissionRateError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message !== ''
      ? error.message
      : '操作失败，请稍后重试';
  }
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return '这个员工在该公司、该生效日已经有配置了（同员工 + 公司 + 生效日唯一，D77 ①）；请换一个生效日，或先删掉旧那条。';
    case 'VALIDATION_FAILED':
      return '员工不属于所选公司，或提成比例不在 0–100% 之间（D80 / D54）；请核对后再提交。';
    case 'NOT_FOUND':
      return '这条配置已经不在了（别人先删了）；刷新一下即可。';
    case 'FORBIDDEN':
      return '当前身份没有提成配置权限（需要 commission.read / commission.create / commission.delete），请联系老板开通。';
    default:
      return describeWriteError(error);
  }
}
