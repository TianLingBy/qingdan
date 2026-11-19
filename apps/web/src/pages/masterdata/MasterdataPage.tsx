import type {
  Customer,
  Processor,
  ProcessorQuote,
  Product,
  Supplier,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { allows, type ScopeAction } from '../../lib/access';
import { useCompanyLabel } from '../../lib/company-directory';
import { resolveListState } from '../../lib/list-state';
import {
  extractIssues,
  formatPrice,
  masterdataApi,
  masterdataQueryKeys,
  optionalText,
  splitList,
  type MasterdataListFilters,
} from './masterdata-api';

export type MasterdataKind = 'products' | 'suppliers' | 'processors' | 'customers';
type MasterdataItem = Product | Supplier | Processor | Customer;

/** 页面 → 权限域（写入口按 `domain.create/update/delete` 做三态，不写死角色名）。 */
const DOMAIN: Record<MasterdataKind, 'product' | 'supplier' | 'processor' | 'customer'> = {
  products: 'product',
  suppliers: 'supplier',
  processors: 'processor',
  customers: 'customer',
};

/** 搜索占位按后端真实命中列写（各 `*ListQuerySchema` 的 `keyword` 口径）。 */
const SEARCH_PLACEHOLDER: Record<MasterdataKind, string> = {
  products: '名称 / 别名',
  customers: '名称 / 联系人',
  suppliers: '名称 / 联系人',
  processors: '名称 / 联系人',
};

interface FormState {
  companyId: string;
  number: string;
  name: string;
  unit: string;
  aliases: string;
  specification: string;
  defaultSalePrice: string;
  contactName: string;
  contactPhone: string;
  suppliedMaterials: string;
  creditTermDays: string;
}

const EMPTY_FORM: FormState = {
  companyId: '',
  number: '',
  name: '',
  unit: '件',
  aliases: '',
  specification: '',
  defaultSalePrice: '',
  contactName: '',
  contactPhone: '',
  suppliedMaterials: '',
  creditTermDays: '',
};

const PAGE_COPY: Record<
  MasterdataKind,
  { title: string; singular: string; description: string }
> = {
  products: {
    title: '商品资料',
    singular: '商品',
    description: '维护商品名称、别名、规格、单位和默认售价。',
  },
  suppliers: {
    title: '供应商档案',
    singular: '供应商',
    description: '维护供应商联系人、电话和供货物料。',
  },
  processors: {
    title: '加工厂档案',
    singular: '加工厂',
    description: '维护加工厂联系人，并查询历史加工报价。',
  },
  customers: {
    title: '客户档案',
    singular: '客户',
    description: '维护客户名称、联系人和账期（不记任何金额，售价与折扣不在这里）。',
  },
};

function readNumber(item: MasterdataItem, kind: MasterdataKind): string | null {
  if (kind === 'products' && 'productNo' in item) return item.productNo;
  if (kind === 'suppliers' && 'supplierNo' in item) return item.supplierNo;
  if (kind === 'processors' && 'processorNo' in item) return item.processorNo;
  if (kind === 'customers' && 'customerNo' in item) return item.customerNo;
  return null;
}

function readContactName(item: MasterdataItem): string | null {
  return 'contactName' in item ? item.contactName : null;
}

function readExtra(item: MasterdataItem, kind: MasterdataKind): string {
  if (kind === 'products' && 'aliases' in item) {
    return [item.specification, item.aliases.join('、'), item.unit].filter(Boolean).join(' · ');
  }
  if (kind === 'suppliers' && 'suppliedMaterials' in item) {
    return [item.contactPhone, item.suppliedMaterials.join('、')].filter(Boolean).join(' · ');
  }
  if (kind === 'customers' && 'creditTermDays' in item) {
    const term = item.creditTermDays === null ? null : `账期 ${item.creditTermDays} 天`;
    return [item.contactName, item.contactPhone, term].filter(Boolean).join(' · ');
  }
  return readContactName(item) ?? '—';
}

function readPrice(item: MasterdataItem, kind: MasterdataKind): string | null {
  return kind === 'products' && 'defaultSalePrice' in item ? item.defaultSalePrice : null;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

/**
 * 删除失败提示：被单据引用时后端返回 409 `STATE_CONFLICT` + `details.reason = HAS_REFERENCES`，
 * 直接显示后端的 message（如「该客户还有单据在用，不能删除」），不要吞成通用「操作失败」。
 */
export function deleteErrorText(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === 'STATE_CONFLICT' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { reason?: unknown }).reason === 'HAS_REFERENCES'
  ) {
    return error.message;
  }
  return errorText(error);
}

function formFromItem(item: MasterdataItem, kind: MasterdataKind): FormState {
  return {
    ...EMPTY_FORM,
    companyId: item.companyId,
    number: readNumber(item, kind) ?? '',
    name: item.name,
    contactName: readContactName(item) ?? '',
    contactPhone:
      (kind === 'suppliers' || kind === 'customers') && 'contactPhone' in item
        ? (item.contactPhone ?? '')
        : '',
    creditTermDays:
      kind === 'customers' && 'creditTermDays' in item && item.creditTermDays !== null
        ? String(item.creditTermDays)
        : '',
    suppliedMaterials:
      kind === 'suppliers' && 'suppliedMaterials' in item
        ? item.suppliedMaterials.join('、')
        : '',
    unit: kind === 'products' && 'unit' in item ? item.unit : '件',
    aliases: kind === 'products' && 'aliases' in item ? item.aliases.join('、') : '',
    specification:
      kind === 'products' && 'specification' in item ? (item.specification ?? '') : '',
    defaultSalePrice:
      kind === 'products' && 'defaultSalePrice' in item ? (item.defaultSalePrice ?? '') : '',
  };
}

function EntityForm({
  kind,
  form,
  editing,
  companyIds,
  canViewPrice,
  busy,
  issues,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: MasterdataKind;
  form: FormState;
  editing: MasterdataItem | null;
  companyIds: readonly string[];
  canViewPrice: boolean;
  busy: boolean;
  issues: readonly { path: string; message: string }[];
  onChange: (field: keyof FormState, value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const copy = PAGE_COPY[kind];
  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{editing ? `编辑${copy.singular}` : `新增${copy.singular}`}</h2>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-900">
          取消
        </button>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-slate-600">所属公司</span>
          <select
            value={form.companyId}
            onChange={(event) => onChange('companyId', event.target.value)}
            disabled={editing !== null}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 disabled:bg-slate-100"
          >
            {companyIds.length === 0 && <option value="">当前账号没有可用公司</option>}
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">名称</span>
          <input
            required
            value={form.name}
            onChange={(event) => onChange('name', event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">编号（可选，仅展示）</span>
          <input
            value={form.number}
            onChange={(event) => onChange('number', event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>

        {kind === 'products' && (
          <>
            <label className="text-sm">
              <span className="text-slate-600">单位</span>
              <input
                required
                value={form.unit}
                onChange={(event) => onChange('unit', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-600">默认售价</span>
              <input
                inputMode="decimal"
                value={form.defaultSalePrice}
                disabled={!canViewPrice}
                onChange={(event) => onChange('defaultSalePrice', event.target.value)}
                placeholder={canViewPrice ? '如 12.50' : '无看价权限'}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-slate-600">别名（逗号分隔）</span>
              <input
                value={form.aliases}
                onChange={(event) => onChange('aliases', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-slate-600">规格</span>
              <input
                value={form.specification}
                onChange={(event) => onChange('specification', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </>
        )}

        {(kind === 'suppliers' || kind === 'processors' || kind === 'customers') && (
          <label className="text-sm">
            <span className="text-slate-600">联系人</span>
            <input
              value={form.contactName}
              onChange={(event) => onChange('contactName', event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
        )}
        {kind === 'customers' && (
          <>
            <label className="text-sm">
              <span className="text-slate-600">联系电话</span>
              <input
                value={form.contactPhone}
                onChange={(event) => onChange('contactPhone', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-600">账期（天，可空）</span>
              <input
                inputMode="numeric"
                value={form.creditTermDays}
                onChange={(event) => onChange('creditTermDays', event.target.value)}
                placeholder="如 30；留空表示未设置"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </>
        )}
        {kind === 'suppliers' && (
          <>
            <label className="text-sm">
              <span className="text-slate-600">联系电话</span>
              <input
                value={form.contactPhone}
                onChange={(event) => onChange('contactPhone', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="text-slate-600">供货物料（逗号分隔）</span>
              <input
                value={form.suppliedMaterials}
                onChange={(event) => onChange('suppliedMaterials', event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              {issue.path ? `${issue.path}：` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      <button
        type="submit"
        disabled={busy || !form.companyId}
        className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? '保存中…' : editing ? '保存修改' : `新增${copy.singular}`}
      </button>
    </form>
  );
}

export function ProcessorQuotes({
  processor,
  canQuote,
}: {
  processor: Processor;
  /** `processor.create` —— 后端 `createQuote` 用的是 create，不是 update（后端说了算）。 */
  canQuote: boolean;
}) {
  const queryClient = useQueryClient();
  const [quoteDate, setQuoteDate] = useState(new Date().toISOString().slice(0, 10));
  const [processName, setProcessName] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [remark, setRemark] = useState('');
  const quotes = useQuery({
    queryKey: masterdataQueryKeys.processorQuotes(processor.id),
    queryFn: () => masterdataApi.listProcessorQuotes(processor.id),
  });
  const createQuote = useMutation({
    mutationFn: () =>
      masterdataApi.createProcessorQuote({
        companyId: processor.companyId,
        processorId: processor.id,
        quoteDate,
        processName,
        unitPrice,
        remark: optionalText(remark) ?? null,
      }),
    onSuccess: async () => {
      setProcessName('');
      setUnitPrice('');
      setRemark('');
      await queryClient.invalidateQueries({
        queryKey: masterdataQueryKeys.processorQuotes(processor.id),
      });
    },
  });

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{processor.name} · 历史加工报价</h2>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          createQuote.mutate();
        }}
      >
        <input
          required
          type="date"
          value={quoteDate}
          onChange={(event) => setQuoteDate(event.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          required
          value={processName}
          onChange={(event) => setProcessName(event.target.value)}
          placeholder="工序"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <input
          required
          inputMode="decimal"
          value={unitPrice}
          onChange={(event) => setUnitPrice(event.target.value)}
          placeholder="单价"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={!canQuote || createQuote.isPending}
          title={canQuote ? undefined : '需要 processor.create 权限'}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          记录报价
        </button>
        <input
          value={remark}
          onChange={(event) => setRemark(event.target.value)}
          placeholder="备注（可选）"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2"
        />
      </form>
      {createQuote.error && (
        <p className="mt-3 text-sm text-red-700">{errorText(createQuote.error)}</p>
      )}
      {/* 报价子表同样走四态（data-state 驱动，状态行常驻） */}
      <div
        className="mt-4 overflow-x-auto"
        data-state={resolveListState({
          isPending: quotes.isPending,
          hasError: quotes.error !== null,
          isEmpty: (quotes.data?.items.length ?? 0) === 0,
        })}
      >
        <div className="st-block st-filled">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs text-slate-500">
              <tr>
                <th className="py-2">日期</th>
                <th className="py-2">工序</th>
                <th className="py-2">单价</th>
                <th className="py-2">备注</th>
              </tr>
            </thead>
            <tbody>
              {(quotes.data?.items ?? []).map((quote: ProcessorQuote) => (
                <tr key={quote.id} className="border-b border-slate-100">
                  <td className="py-2">{quote.quoteDate}</td>
                  <td className="py-2">{quote.processName}</td>
                  <td className="py-2">{quote.unitPrice}</td>
                  <td className="py-2">{quote.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="st-block st-loading">
          <ListLoading label="报价加载中…" rows={2} />
        </div>
        <div className="st-block st-error">
          <ListError title="报价加载失败" error={quotes.error ?? null} onRetry={() => void quotes.refetch()} />
        </div>
        <div className="st-block st-empty">
          <ListEmpty title="暂无报价记录。" />
        </div>
      </div>
    </section>
  );
}

export function MasterdataPage({ kind }: { kind: MasterdataKind }) {
  const copy = PAGE_COPY[kind];
  const queryClient = useQueryClient();
  const companyLabel = useCompanyLabel();
  const [keyword, setKeyword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<MasterdataItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedProcessor, setSelectedProcessor] = useState<Processor | null>(null);

  const me = useQuery({ queryKey: masterdataQueryKeys.me, queryFn: masterdataApi.me });
  const companyIds = me.data?.companyIds ?? [];
  const domain = DOMAIN[kind];
  /** 写入口三态：有权限可点；无权限禁用并在 title 写明缺哪个 scope（不藏按钮）。 */
  const can = (action: ScopeAction) => allows(me.data?.scope, domain, action);
  const canCreate = can('create');
  const canUpdate = can('update');
  const canDelete = can('delete');
  const denyText = (action: ScopeAction) => `需要 ${domain}.${action} 权限`;
  const canViewPrice =
    me.data?.scope.some(
      (entry) => entry.domain === 'product' && entry.actions.includes('view_price'),
    ) ?? false;

  useEffect(() => {
    if (form.companyId.length === 0 && companyIds[0]) {
      setForm((current) => ({ ...current, companyId: companyIds[0]! }));
    }
  }, [companyIds, form.companyId]);

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [keyword, companyId]);

  const filters: MasterdataListFilters = {
    keyword: optionalText(keyword),
    companyId: optionalText(companyId),
    cursor: cursors[pageIndex] ?? null,
  };
  const list = useQuery({
    queryKey: masterdataQueryKeys.list(kind, {
      keyword: filters.keyword,
      companyId: filters.companyId,
      cursor: filters.cursor,
    }),
    queryFn: async () => {
      if (kind === 'products') return masterdataApi.listProducts(filters);
      if (kind === 'suppliers') return masterdataApi.listSuppliers(filters);
      if (kind === 'customers') return masterdataApi.listCustomers(filters);
      return masterdataApi.listProcessors(filters);
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!form.companyId) throw new Error('请选择所属公司');
      if (kind === 'products') {
        const common = {
          name: form.name.trim(),
          productNo: optionalText(form.number) ?? null,
          aliases: splitList(form.aliases),
          specification: optionalText(form.specification) ?? null,
        };
        if (editing) {
          return masterdataApi.updateProduct(
            editing.id,
            {
              ...common,
              unit: form.unit.trim(),
              ...(canViewPrice
                ? { defaultSalePrice: optionalText(form.defaultSalePrice) ?? null }
                : {}),
            },
            editing.version,
          );
        }
        return masterdataApi.createProduct({
          companyId: form.companyId,
          ...common,
          unit: form.unit.trim(),
          ...(canViewPrice
            ? { defaultSalePrice: optionalText(form.defaultSalePrice) ?? null }
            : {}),
        });
      }

      if (kind === 'suppliers') {
        const common = {
          name: form.name.trim(),
          supplierNo: optionalText(form.number) ?? null,
          contactName: optionalText(form.contactName) ?? null,
          contactPhone: optionalText(form.contactPhone) ?? null,
          suppliedMaterials: splitList(form.suppliedMaterials),
        };
        return editing
          ? masterdataApi.updateSupplier(editing.id, common, editing.version)
          : masterdataApi.createSupplier({ companyId: form.companyId, ...common });
      }

      if (kind === 'customers') {
        const termText = form.creditTermDays.trim();
        const creditTermDays = termText.length === 0 ? null : Number(termText);
        if (creditTermDays !== null && (!Number.isInteger(creditTermDays) || creditTermDays < 0)) {
          throw new Error('账期必须是大于等于 0 的整数天');
        }
        const common = {
          name: form.name.trim(),
          customerNo: optionalText(form.number) ?? null,
          contactName: optionalText(form.contactName) ?? null,
          contactPhone: optionalText(form.contactPhone) ?? null,
          creditTermDays,
        };
        return editing
          ? masterdataApi.updateCustomer(editing.id, common, editing.version)
          : masterdataApi.createCustomer({ companyId: form.companyId, ...common });
      }

      const common = {
        name: form.name.trim(),
        processorNo: optionalText(form.number) ?? null,
        contactName: optionalText(form.contactName) ?? null,
      };
      return editing
        ? masterdataApi.updateProcessor(editing.id, common, editing.version)
        : masterdataApi.createProcessor({ companyId: form.companyId, ...common });
    },
    onSuccess: async () => {
      setForm({ ...EMPTY_FORM, companyId: companyIds[0] ?? '' });
      setEditing(null);
      setFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['masterdata', kind] });
    },
  });

  const disable = useMutation<MasterdataItem, Error, MasterdataItem>({
    mutationFn: (item: MasterdataItem) => {
      if (kind === 'products') return masterdataApi.disableProduct(item.id, item.version);
      if (kind === 'suppliers') return masterdataApi.disableSupplier(item.id, item.version);
      if (kind === 'customers') return masterdataApi.disableCustomer(item.id, item.version);
      return masterdataApi.disableProcessor(item.id, item.version);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['masterdata', kind] });
    },
  });

  const beginCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, companyId: companyIds[0] ?? '' });
    setFormOpen(true);
  };
  const beginEdit = (item: MasterdataItem) => {
    setEditing(item);
    setForm(formFromItem(item, kind));
    setFormOpen(true);
    setSelectedProcessor(null);
  };
  const askDisable = (item: MasterdataItem) => {
    if (globalThis.confirm?.(`确认删除“${item.name}”吗？删除后不能恢复。`) === false) {
      return;
    }
    disable.mutate(item);
  };

  const issues = save.error instanceof ApiError ? extractIssues(save.error.details) : [];
  const rows = (list.data?.items ?? []) as MasterdataItem[];
  const nextCursor = list.data?.nextCursor ?? null;
  /**
   * 列表四态（v0.13）：只算一个字符串交给容器与 tbody 的 `data-state`，
   * 三个状态行常驻 DOM、由 CSS 显隐，不写 JSX 三元分支（见 styles/README.md §四态）。
   */
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });
  const isProducts = kind === 'products';
  /** 商品页把「补充信息」拆成 别名 / 规格 / 单位 三列（改稿清单 §2.1）。 */
  const colCount = isProducts ? 7 : 4;

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{copy.description}</p>
        </div>
        <button
          type="button"
          onClick={beginCreate}
          disabled={!canCreate}
          title={canCreate ? undefined : denyText('create')}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          新增{copy.singular}
        </button>
      </header>

      <div className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={SEARCH_PLACEHOLDER[kind]}
          className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        {/* 公司筛选：`*ListQuerySchema` 都有 companyId 参数，后端已支持。 */}
        {companyIds.length > 1 && (
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            aria-label="按公司筛选"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">全部公司</option>
            {companyIds.map((id) => (
              <option key={id} value={id} title={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        )}
      </div>

      {formOpen && (
        <EntityForm
          kind={kind}
          form={form}
          editing={editing}
          companyIds={companyIds}
          canViewPrice={canViewPrice}
          busy={save.isPending}
          issues={issues}
          onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
            save.reset();
          }}
        />
      )}

      {save.error && issues.length === 0 && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{errorText(save.error)}</p>
      )}
      {disable.error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {deleteErrorText(disable.error)}
        </p>
      )}

      {/*
        列表区（v0.13）。四态由容器与 tbody 上的 `data-state` 驱动，**不写 JSX 分支**：
        `app-v013.css` 的 `tbody[data-state] > tr.st-tr.st-*` 负责显隐，表头宽度不随状态变。
        数据行只带 `r-row`，**不要带 `st-tr`**（会落在「默认隐藏」规则里，见 #337）。
      */}
      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr>
                <th>编号</th>
                <th>名称</th>
                {isProducts ? (
                  <>
                    <th>别名</th>
                    <th>规格</th>
                    <th>单位</th>
                  </>
                ) : (
                  <th>补充信息</th>
                )}
                {isProducts && <th className="num">默认售价</th>}
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              {/* 三个状态行常驻 DOM，CSS 按 data-state 只显示其中一个 */}
              <tr className="st-tr st-loading">
                <td colSpan={colCount}>
                  <ListLoading label={`正在加载${copy.title}…`} rows={4} />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={colCount}>
                  <ListError
                    title={`${copy.title}加载失败`}
                    error={list.error ?? null}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={colCount}>
                  <ListEmpty title="暂无数据。可调整筛选条件或新增一条记录。" />
                </td>
              </tr>
              {rows.map((item) => (
                <tr key={item.id} className="r-row">
                  <td className="px-4 py-3 text-slate-500">{readNumber(item, kind) ?? '—'}</td>
                  <td className="px-4 py-3 font-medium">{item.name}</td>
                  {isProducts && 'aliases' in item ? (
                    <>
                      <td className="px-4 py-3 text-slate-600">{item.aliases.join('、') || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{item.specification ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{item.unit}</td>
                    </>
                  ) : (
                    <td className="px-4 py-3 text-slate-600">{readExtra(item, kind) || '—'}</td>
                  )}
                  {isProducts && (
                    <td className="px-4 py-3">{formatPrice(readPrice(item, kind))}</td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {kind === 'processors' && (
                        <button
                          type="button"
                          onClick={() => setSelectedProcessor(item as Processor)}
                          className="rounded border border-slate-300 px-2 py-1 text-xs"
                        >
                          报价
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => beginEdit(item)}
                        disabled={!canUpdate}
                        title={canUpdate ? undefined : denyText('update')}
                        className="rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={!canDelete || disable.isPending}
                        onClick={() => askDisable(item)}
                        title={canDelete ? undefined : denyText('delete')}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        游标分页：只保留「上一页 / 下一页」。
        TODO(#341): 页码条——主数据仍是 `PageQuerySchema`（只有 cursor/limit），
        后端补 total 之后再按 v0.13 的 `.pager` 画页码与总数。
      */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={pageIndex === 0}
          onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          上一页
        </button>
        <span className="text-sm text-slate-500">第 {pageIndex + 1} 页</span>
        <button
          type="button"
          disabled={!nextCursor}
          onClick={() => {
            if (!nextCursor) return;
            setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
            setPageIndex((index) => index + 1);
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          下一页
        </button>
      </div>

      {selectedProcessor && (
        <ProcessorQuotes
          processor={selectedProcessor}
          canQuote={allows(me.data?.scope, 'processor', 'create')}
        />
      )}
    </section>
  );
}

export function ProductsPage() {
  return <MasterdataPage kind="products" />;
}

export function SuppliersPage() {
  return <MasterdataPage kind="suppliers" />;
}

export function ProcessorsPage() {
  return <MasterdataPage kind="processors" />;
}

export function CustomersPage() {
  return <MasterdataPage kind="customers" />;
}
