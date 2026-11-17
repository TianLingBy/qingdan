import { z } from 'zod';

/**
 * 开单时的「顺手建档」入参（#302 块 C 前半段，D100）。
 *
 * 为什么单独一个文件：E / A / B 三张单各自要带上「客户 / 供应商 / 加工厂」的最小档案，
 * 但这三份档案**不是** masterdata 的创建入参——它们没有 `companyId`（公司必须取单据自身的，
 * 前端传的一律不看，见 D100 第 4 条），也不允许改编号（编号由服务端按 D16 生成）。
 * 放在这里是为了让三张单的契约共享同一份字段定义，避免三处各写一遍后漂移。
 *
 * 只收「开单现场能知道」的字段：名称 + 联系方式（+ 客户账期 / 供应商供货物料）。
 * 其余字段（地址、税号、银行账号）留空，员工事后去主数据页补。
 */

/** 客户草档：`name` 必填，其余与 `CustomerCreateInputSchema` 的可选字段对齐。 */
export const CustomerDraftSchema = z.object({
  name: z.string().min(1).max(64),
  contactName: z.string().max(64).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  creditTermDays: z.number().int().min(0).nullable().optional(),
});
export type CustomerDraft = z.infer<typeof CustomerDraftSchema>;

/** 供应商草档。 */
export const SupplierDraftSchema = z.object({
  name: z.string().min(1).max(64),
  contactName: z.string().max(64).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  suppliedMaterials: z.array(z.string().min(1).max(64)).max(20).optional(),
});
export type SupplierDraft = z.infer<typeof SupplierDraftSchema>;

/** 加工厂草档：`processor` 表没有电话列（0006 建表语句），故这里也不收电话。 */
export const ProcessorDraftSchema = z.object({
  name: z.string().min(1).max(64),
  contactName: z.string().max(64).nullable().optional(),
});
export type ProcessorDraft = z.infer<typeof ProcessorDraftSchema>;

/**
 * 公司草档：**只用来报错**。
 *
 * N 单（内部交易）的收发双方都是自己集团内的公司，公司档案属于老板/财务维护的主体信息，
 * 「开单即建档」不覆盖公司（设计 §六「N 单只能选不能建」）。契约上仍然接收这个字段，
 * 是为了让越界请求走到用例层、拿到明确的 422「公司只能选不能建」，
 * 而不是被 zod 静默 strip 掉、表现成「没传」。用例层一旦看到它就拒绝（D100 第 5 条）。
 */
export const CompanyDraftSchema = z.object({
  name: z.string().min(1).max(64),
});
export type CompanyDraft = z.infer<typeof CompanyDraftSchema>;
