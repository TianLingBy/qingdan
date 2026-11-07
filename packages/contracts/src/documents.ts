import { AppError } from './errors.js';

/**
 * 单据框架的公共口径（D4 状态机 / D21 取消级联 / D19 结算时机）。
 * 业务状态枚举保留中文原值（D54 §9-6），前端与 CLI 都不得另造英文枚举。
 */
export const HEADER_STATES = ['进行中', '已完成', '已取消'] as const;
export type HeaderState = (typeof HEADER_STATES)[number];

export interface CancelDecision {
  allowed: boolean;
  /** 不可取消时的口径原因；可取消时为 null。 */
  reason: 'already_completed' | 'already_cancelled' | 'has_downstream' | null;
}

/**
 * 取消级联（D21）：
 * - 未完成且无直接下游引用 → 可取消，库存流水同事务回滚；
 * - 有直接下游 → 不可取消（先取消下游，逆向解锁，每次只查直接下游）；
 * - 已完成 / 已取消 → 一律不可取消，错账走冲正 R/S/I（D30）。
 */
export function canCancel(state: HeaderState, hasDirectDownstream: boolean): CancelDecision {
  if (state === '已完成') return { allowed: false, reason: 'already_completed' };
  if (state === '已取消') return { allowed: false, reason: 'already_cancelled' };
  if (hasDirectDownstream) return { allowed: false, reason: 'has_downstream' };
  return { allowed: true, reason: null };
}

export function assertCancelable(state: HeaderState, hasDirectDownstream: boolean): void {
  const decision = canCancel(state, hasDirectDownstream);
  if (decision.allowed) return;
  if (decision.reason === 'has_downstream') {
    throw new AppError('VERSION_CONFLICT', '存在直接下游单据，请先取消下游', { reason: decision.reason });
  }
  throw new AppError('VALIDATION_FAILED', '该状态不可取消，错账请走冲正单据', { reason: decision.reason });
}

/** C 单生成时机（D19/D29）：E/N 单单头「已完成」时自动生成草稿，财务确认后生效。 */
export function shouldDraftSettlement(headerState: HeaderState): boolean {
  return headerState === '已完成';
}
