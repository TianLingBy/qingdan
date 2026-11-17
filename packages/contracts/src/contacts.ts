import { z } from 'zod';
import { defineRoute, type RouteDef } from './registry.js';

/**
 * 客户 / 供应商 / 加工厂对接人契约（#306，设计文档 §十一）。
 *
 * 口径约束（别在这里「顺手加字段」）：
 * - **对接人是档案的从属数据，不是独立功能域**（D92 补句）：权限沿用
 *   `customer.* / supplier.* / processor.*` 既有的 `read / create / update / delete`，
 *   本文件不新增任何 domain / action；
 * - 三张表同构（`customer_contact / supplier_contact / processor_contact`），
 *   实体形状共用 `contactFields`，只多一个归属档案字段（`customerId` / `supplierId` /
 *   `processorId`）；
 * - **列表脱敏**：列表只回 `phoneMasked`（后 4 位），详情 / 写回体回完整 `phone`；
 * - **删除 = 软停用**：`DELETE` 的用户语义是「删掉这个对接人」，实现是
 *   `UPDATE status = '停用'`，历史单据仍可读到引用与姓名（见 usecases/contacts.ts）；
 * - 金额：`summary.totalAmount` 与每条 `recentOrders[].totalAmount` 都需要
 *   `view_price`；**没有该权限时用例直接不赋这个键**（不是 null，也不是 0）。
 */

/** decimal 字符串（与 sales-orders.ts 同口径：非负、最多 6 位小数，D54）。 */
const AmountString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, '必须是 decimal 字符串（非负、最多 6 位小数）');

export const CONTACT_STATES = ['启用', '停用'] as const;
export type ContactStatus = (typeof CONTACT_STATES)[number];

/** 对接人公共形状（三张表同构的部分）。 */
const contactFields = {
  id: z.string(),
  tenantId: z.string(),
  /** 公司隔离（D15）：对接人随档案归属单一公司，跨公司不可见。 */
  companyId: z.string(),
  name: z.string(),
  /** 完整手机号：只在详情 / 写回体 / 汇总页出现。 */
  phone: z.string().nullable(),
  /** 职务 / 称呼（「采购主管」「老板娘」这类自由文本）。 */
  title: z.string().nullable(),
  /** 主对接人：每档案最多一个（迁移里的部分唯一索引兜底）。 */
  isPrimary: z.boolean(),
  status: z.enum(CONTACT_STATES),
  /** 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。 */
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
} as const;

export const CustomerContactSchema = z.object({ ...contactFields, customerId: z.string() });
export const SupplierContactSchema = z.object({ ...contactFields, supplierId: z.string() });
export const ProcessorContactSchema = z.object({ ...contactFields, processorId: z.string() });

export type CustomerContact = z.infer<typeof CustomerContactSchema>;
export type SupplierContact = z.infer<typeof SupplierContactSchema>;
export type ProcessorContact = z.infer<typeof ProcessorContactSchema>;

/**
 * 列表口径：手机号只回掩码（后 4 位），完整号码不出现在列表响应里。
 * 掩码字符用 `*`（与 employee.phoneMasked 一致）。
 */
export const CustomerContactSummarySchema = CustomerContactSchema.omit({ phone: true }).extend({
  phoneMasked: z.string().nullable(),
});
export const SupplierContactSummarySchema = SupplierContactSchema.omit({ phone: true }).extend({
  phoneMasked: z.string().nullable(),
});
export const ProcessorContactSummarySchema = ProcessorContactSchema.omit({ phone: true }).extend({
  phoneMasked: z.string().nullable(),
});

/** 新增对接人：`name` 必填；手机号可选（DB 的 employee.phone 同口径 `^1[0-9]{10}$`）。 */
export const ContactCreateInputSchema = z.object({
  name: z.string().min(1).max(64),
  phone: z
    .string()
    .regex(/^1[0-9]{10}$/, '手机号必须是 11 位、以 1 开头')
    .nullable()
    .optional(),
  title: z.string().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

/** 修改对接人：全字段可选、至少要改一个；归属档案不可改（换档案 = 新建一条）。 */
export const ContactUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    phone: z
      .string()
      .regex(/^1[0-9]{10}$/, '手机号必须是 11 位、以 1 开头')
      .nullable()
      .optional(),
    title: z.string().max(64).nullable().optional(),
    isPrimary: z.boolean().optional(),
    /** 软停用 / 重新启用。`DELETE` 也落到同一个值上（见 usecases/contacts.ts）。 */
    status: z.enum(CONTACT_STATES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少修改一个字段' });

export type ContactCreateInput = z.infer<typeof ContactCreateInputSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateInputSchema>;

/** 档案详情聚合里的最近单据条目（最多 10 条）。 */
export const ContactRecentOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  status: z.string(),
  /** 无 `view_price` 时不出现这个键（与汇总的 `totalAmount` 同口径）。 */
  totalAmount: AmountString.optional(),
  createdAt: z.string().datetime(),
});
export type ContactRecentOrder = z.infer<typeof ContactRecentOrderSchema>;

const summaryFields = {
  /** 单据数（不含已取消；只统计本公司的单）。 */
  orderCount: z.number().int(),
  /** 累计金额；无 `view_price` 时**键不存在**。 */
  totalAmount: AmountString.optional(),
  /** 最近一张单的时间；没有单据时为 null。 */
  lastOrderAt: z.string().datetime().nullable(),
  /** 最近 10 张单（按创建时间倒序）。 */
  recentOrders: z.array(ContactRecentOrderSchema),
};

export const CustomerSummarySchema = z.object({
  ...summaryFields,
  contacts: z.array(CustomerContactSchema),
});
export const SupplierSummarySchema = z.object({
  ...summaryFields,
  contacts: z.array(SupplierContactSchema),
});
export const ProcessorSummarySchema = z.object({
  ...summaryFields,
  contacts: z.array(ProcessorContactSchema),
});

export type CustomerSummary = z.infer<typeof CustomerSummarySchema>;
export type SupplierSummary = z.infer<typeof SupplierSummarySchema>;
export type ProcessorSummary = z.infer<typeof ProcessorSummarySchema>;

interface ContactKindConfig {
  readonly domain: 'customer' | 'supplier' | 'processor';
  /** 档案中文名，只用于 summary 文案。 */
  readonly label: string;
  /** 档案集合路径段（`customers`）。 */
  readonly entitySegment: string;
  /**
   * 对接人单体路径段（`customer-contacts`）。
   *
   * 为什么不按任务书用 `/api/v1/contacts/{contactId}`：注册表禁止 `${method} ${path}`
   * 重复，三个域共用一条 `/contacts/{id}` 会直接冲突；按域前缀拆开后，
   * 每个域仍能各自校验 `customer.update` / `supplier.update` / `processor.update`。
   */
  readonly contactSegment: string;
  readonly contactSchema: z.ZodTypeAny;
  readonly maskedSchema: z.ZodTypeAny;
  readonly summarySchema: z.ZodTypeAny;
}

function contactRoutes(config: ContactKindConfig): RouteDef[] {
  const { domain, label, entitySegment, contactSegment } = config;
  return [
    defineRoute({
      module: 'masterdata',
      operationId: `${domain}.contact.list`,
      method: 'GET',
      path: `/api/v1/${entitySegment}/{id}/contacts`,
      domain,
      action: 'read',
      summary: `${label}对接人列表（手机号只回后 4 位掩码）`,
      // 普通读不记审计（D54②）。
      audit: { kind: 'none' },
      response: { status: 200, schema: z.array(config.maskedSchema) },
    }),
    defineRoute({
      module: 'masterdata',
      operationId: `${domain}.contact.create`,
      method: 'POST',
      path: `/api/v1/${entitySegment}/{id}/contacts`,
      domain,
      action: 'create',
      summary: `新增${label}对接人（isPrimary 为真时自动把原主对接人降级）`,
      audit: { kind: 'write' },
      ai: { policy: 'allow' },
      request: { body: ContactCreateInputSchema },
      response: { status: 201, schema: config.contactSchema },
    }),
    defineRoute({
      module: 'masterdata',
      operationId: `${domain}.contact.update`,
      method: 'PATCH',
      path: `/api/v1/${contactSegment}/{contactId}`,
      domain,
      action: 'update',
      summary: `修改${label}对接人（强 ETag If-Match；可改 status 重新启用）`,
      audit: { kind: 'write' },
      ai: { policy: 'allow' },
      requiresIfMatch: true,
      request: { body: ContactUpdateInputSchema },
      response: { status: 200, schema: config.contactSchema },
    }),
    defineRoute({
      module: 'masterdata',
      operationId: `${domain}.contact.delete`,
      method: 'DELETE',
      path: `/api/v1/${contactSegment}/{contactId}`,
      domain,
      action: 'delete',
      // action 仍是 delete：用户语义就是「删掉这个对接人」。实现是软停用
      // （UPDATE status='停用'），所以已开出的单据仍能读到引用与姓名。
      summary: `删除${label}对接人（软停用：status 置「停用」，历史单仍可读）`,
      audit: { kind: 'write' },
      ai: { policy: 'forbid', reasonRequired: true },
      requiresIfMatch: true,
      response: { status: 200, schema: config.contactSchema },
    }),
    defineRoute({
      module: 'masterdata',
      operationId: `${domain}.summary.read`,
      method: 'GET',
      path: `/api/v1/${entitySegment}/{id}/summary`,
      domain,
      action: 'read',
      summary: `${label}档案汇总（单数/累计金额/最近单据/对接人；金额需 view_price）`,
      audit: { kind: 'none' },
      response: { status: 200, schema: config.summarySchema },
    }),
  ];
}

/**
 * 15 条路由：三个域 × (对接人 list/create/update/delete + 档案 summary)。
 *
 * 权限：读 `customer.read` 等；增删改对接人用对应域的 `create` / `update` / `delete`；
 * `summary.totalAmount` 额外要 `view_price`（用例内判定，不在 scope 里体现）。
 */
export const CONTACT_ROUTES: readonly RouteDef[] = [
  ...contactRoutes({
    domain: 'customer',
    label: '客户',
    entitySegment: 'customers',
    contactSegment: 'customer-contacts',
    contactSchema: CustomerContactSchema,
    maskedSchema: CustomerContactSummarySchema,
    summarySchema: CustomerSummarySchema,
  }),
  ...contactRoutes({
    domain: 'supplier',
    label: '供应商',
    entitySegment: 'suppliers',
    contactSegment: 'supplier-contacts',
    contactSchema: SupplierContactSchema,
    maskedSchema: SupplierContactSummarySchema,
    summarySchema: SupplierSummarySchema,
  }),
  ...contactRoutes({
    domain: 'processor',
    label: '加工厂',
    entitySegment: 'processors',
    contactSegment: 'processor-contacts',
    contactSchema: ProcessorContactSchema,
    maskedSchema: ProcessorContactSummarySchema,
    summarySchema: ProcessorSummarySchema,
  }),
];
