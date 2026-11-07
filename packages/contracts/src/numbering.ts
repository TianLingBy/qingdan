import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * 编号规则（D16 / D48）：`类型字母-公司码(4)-日期(8)-流水(4)`。
 * 流水按月重置；工号另行 6 位全局唯一（见 formatEmployeeNo）。
 * 唯一性由并发安全取号保证（platform/numbering），本文件只负责格式与校验。
 */
export const DOCUMENT_TYPES = {
  A: '采购单',
  B: '加工单',
  E: '销售单',
  N: '内部交易单',
  C: '结算单',
  R: '客户退货',
  S: '供应商退货',
  I: '盘点调整',
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;

export const COMPANY_CODE_LENGTH = 4;
export const SEQUENCE_LENGTH = 4;
export const EMPLOYEE_NO_LENGTH = 6;

export const DOCUMENT_NO_PATTERN = /^[ABENCRSI]-\d{4}-\d{8}-\d{4}$/;
export const EMPLOYEE_NO_PATTERN = /^\d{6}$/;

export interface DocumentNoParts {
  type: DocumentType;
  /** 租户内公司码，0001~9999，定长 4 位（D16）。 */
  companyCode: number;
  /** 业务日期，YYYYMMDD（按租户时区）。 */
  date: Date;
  /** 当月流水，0001~9999，按月重置。 */
  sequence: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatDocumentNo(parts: DocumentNoParts): string {
  const { type, companyCode, date, sequence } = parts;
  if (!(type in DOCUMENT_TYPES)) throw new AppError('VALIDATION_FAILED', `未知单据类型 ${String(type)}`);
  if (!Number.isInteger(companyCode) || companyCode < 1 || companyCode > 9999) {
    throw new AppError('VALIDATION_FAILED', `公司码必须是 1~9999 的整数，收到 ${companyCode}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new AppError('VALIDATION_FAILED', `月流水必须是 1~9999，收到 ${sequence}；超限需立项扩容`);
  }
  const ymd = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
  return `${type}-${pad(companyCode, COMPANY_CODE_LENGTH)}-${ymd}-${pad(sequence, SEQUENCE_LENGTH)}`;
}

/** 工号（D48）：定长 6 位、全租户全局唯一、不带公司前缀。 */
export function formatEmployeeNo(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999) {
    throw new AppError('VALIDATION_FAILED', `工号流水必须是 1~999999，收到 ${seq}`);
  }
  return pad(seq, EMPLOYEE_NO_LENGTH);
}

export const DocumentNoSchema = z.string().regex(DOCUMENT_NO_PATTERN, '单号格式：类型字母-公司码(4)-日期(8)-流水(4)');
export const EmployeeNoSchema = z.string().regex(EMPLOYEE_NO_PATTERN, '工号格式：6 位数字');
