import type {
  ContactCreateInput,
  ContactRecentOrder,
  ContactSummaryGroup,
  ContactUpdateInput,
  CustomerContact,
  ProcessorContact,
  SupplierContact,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

/**
 * 客户 / 供应商 / 加工厂对接人接口（#306，契约 `packages/contracts/src/contacts.ts`）。
 *
 * 三个域的端点同构，只是路径段不同：
 * - 集合：`/{customers|suppliers|processors}/{id}/contacts`（GET 只回 `phoneMasked`）
 * - 单体：`/{customer|supplier|processor}-contacts/{contactId}`（PATCH / DELETE，强 ETag）
 * - 汇总：`/{entity}/{id}/summary`（带 `groupBy=contact` 时才回 `contactGroups`）
 *
 * 金额口径：没有 `view_price` 时后端**不赋 `totalAmount` 这个键**（不是 null、不是 0），
 * 前端只能当「键不存在」处理，显示占位符 `—`，绝不能 `?? 0`。
 */
export type ContactKind = 'customers' | 'suppliers' | 'processors';

/** 对接人完整形状（详情 / 写回体，含完整 `phone`）。 */
export type ContactFull = CustomerContact | SupplierContact | ProcessorContact;

/** 对接人列表形状（列表口径，只有 `phoneMasked`）。契约里只导出了 Schema 未导出对应 type，故本地声明。 */
export interface ContactSummaryRow {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly name: string;
  readonly title: string | null;
  readonly isPrimary: boolean;
  readonly status: '启用' | '停用';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phoneMasked: string | null;
}

/** 三种档案的 summary 结构一致（`summaryFields` 共用），前端按一个形状消费。 */
export interface ContactSummary {
  readonly orderCount: number;
  /** 无 `view_price` 时**键不存在**。 */
  readonly totalAmount?: string;
  readonly lastOrderAt: string | null;
  readonly recentOrders: readonly ContactRecentOrder[];
  /** 只在 `?groupBy=contact` 时出现。 */
  readonly contactGroups?: readonly ContactSummaryGroup[];
  readonly contacts: readonly ContactFull[];
}

const CONTACT_SEGMENT: Record<ContactKind, string> = {
  customers: 'customer-contacts',
  suppliers: 'supplier-contacts',
  processors: 'processor-contacts',
};

function ifMatch(version: number): Record<string, string> {
  return { 'If-Match': `"${version}"` };
}

export function createContactsApi(client: ApiClient = apiClient) {
  return {
    /** 档案汇总；`groupBy=contact` 时附按对接人分组（含 `contactId=null` 的「未指定对接人」组）。 */
    summary: (kind: ContactKind, entityId: string, options: { groupByContact?: boolean } = {}) =>
      client.get<ContactSummary>(`/${kind}/${entityId}/summary`, {
        query: options.groupByContact ? { groupBy: 'contact' } : {},
      }),

    listContacts: (kind: ContactKind, entityId: string) =>
      client.get<ContactSummaryRow[]>(`/${kind}/${entityId}/contacts`),

    createContact: (kind: ContactKind, entityId: string, input: ContactCreateInput) =>
      client.post<ContactFull>(`/${kind}/${entityId}/contacts`, input),

    updateContact: (kind: ContactKind, contactId: string, input: ContactUpdateInput, version: number) =>
      client.patch<ContactFull>(`/${CONTACT_SEGMENT[kind]}/${contactId}`, input, {
        headers: ifMatch(version),
      }),

    /** 删除 = 软停用（`status` 置「停用」），历史单据仍能读到引用与姓名。 */
    disableContact: (kind: ContactKind, contactId: string, version: number) =>
      client.delete<ContactFull>(`/${CONTACT_SEGMENT[kind]}/${contactId}`, {
        headers: ifMatch(version),
      }),
  };
}

export const contactsApi = createContactsApi();
