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
import { BatchPager } from '../../components/ListPager';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import {
  DetailHead,
  DetailMetaDot,
  DocMeta,
  type DocMetaItem,
} from '../../components/OrderDetailUI';
import { Icon } from '../../components/icons/Icon';
import { allows, type ScopeAction } from '../../lib/access';
import { useCompanyLabel } from '../../lib/company-directory';
import { resolveListState } from '../../lib/list-state';
import { ContactDrawer } from './ContactDrawer';
import { contactsApi, type ContactKind, type ContactSummaryRow } from './contacts-api';
import {
  extractIssues,
  formatPrice,
  masterdataApi,
  masterdataQueryKeys,
  optionalText,
  splitList,
  type MasterdataListFilters,
} from './masterdata-api';

/**
 * 主数据 4 页（`/products` `/customers` `/suppliers` `/processors`，同一组件四个 kind）。
 *
 * 口径来自 #432 + `docs/ui/frontend-change-rules.md`：
 * - **表头 = 稿子 = `tools/ui-parity/anchors.json`**，一列不多一列不少；
 * - **行内不塞按钮**：点行开详情面板（稿子 `masterAttr()` 给 `<tr>` 挂 `class="click"` + `data-master`），
 *   编辑 / 删除在面板头部，按 `allows(scope, domain, action)` 三态（必做点 1 / 6）；
 * - **详情面板**用仓库既有的 `DetailHead` + `DocMeta` + `.ln`（`components/OrderDetailUI.tsx`，
 *   与采购 / 加工 / 内贸同一套），分组：基本信息 / 联系方式 / 对接人 / 报价记录（必做点 2 / 3 / 4）；
 * - 四态 `data-state` 挂 `<tbody>`，三个占位行常驻（`lib/list-state.ts`）。
 *
 * 三条「稿子有、后端列表没有」的列（客户「价目 / 历史销售」、供应商「历史采购」、
 * 加工厂「加工单 / 报价」）一律显示占位 `—` + `title` 写明缺口，**不在页面上编数据、也不自己造接口**；
 * 口径已提给负责人（#432）。
 */

export type MasterdataKind = 'products' | 'suppliers' | 'processors' | 'customers';
type MasterdataItem = Product | Supplier | Processor | Customer;

/** 页面 → 权限域（写入口按 `domain.create/update/delete` 做三态，不写死角色名）。 */
const DOMAIN: Record<MasterdataKind, 'product' | 'supplier' | 'processor' | 'customer'> = {
  products: 'product',
  suppliers: 'supplier',
  processors: 'processor',
  customers: 'customer',
};

/** 搜索占位按稿子 `searchField()` 原句。 */
const SEARCH_PLACEHOLDER: Record<MasterdataKind, string> = {
  products: '搜索编号、名称…',
  customers: '搜索编号、名称、对接人…',
  suppliers: '搜索编号、名称、对接人…',
  processors: '搜索编号、名称、对接人…',
};

interface Column {
  readonly label: string;
  /** 数字 / 金额列：表头与单元格都右对齐（稿子 `th.r`）。 */
  readonly right?: boolean;
}

/**
 * 表头逐字照抄 `design/v3.0/index.html` 的四个 `simple()` 定义，
 * 与 `tools/ui-parity/anchors.json` 完全一致（机器验收以它为锚点）。
 */
const COLUMNS: Record<MasterdataKind, readonly Column[]> = {
  products: [{ label: '编号' }, { label: '名称' }, { label: '规格' }, { label: '参考价', right: true }],
  customers: [
    { label: '编号' },
    { label: '名称' },
    { label: '对接人' },
    { label: '价目' },
    { label: '历史销售', right: true },
  ],
  suppliers: [
    { label: '编号' },
    { label: '名称' },
    { label: '对接人' },
    { label: '历史采购', right: true },
  ],
  processors: [
    { label: '编号' },
    { label: '名称' },
    { label: '对接人' },
    { label: '加工单', right: true },
    { label: '报价', right: true },
  ],
};

/**
 * 列表列的「后端缺口」说明（作为占位 `—` 的 `title`）。
 * 只写事实 + 已提给负责人的单号，不替后端做决定。
 */
const GAP_TITLE = {
  priceList: '客户档案契约里没有价目字段（客户不带任何金额口径），后端未提供；口径待负责人定（#432）',
  histSales:
    '销售单数只有 GET /customers/{id}/summary，列表接口不返回；一页 20 行要逐行调 20 次，口径待负责人定（#432）。点开行可在详情里看',
  histPurchase:
    '采购单数只有 GET /suppliers/{id}/summary，列表接口不返回；逐行调用属 N+1，口径待负责人定（#432）。点开行可在详情里看',
  histProcessing:
    '加工单数只有 GET /processors/{id}/summary，列表接口不返回；逐行调用属 N+1，口径待负责人定（#432）。点开行可在详情里看',
  quotes:
    '报价条数只有 GET /processor-quotes?processorId=，列表接口不返回；口径待负责人定（#432）。点开行可在详情里看',
} as const;

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
  {
    title: string;
    singular: string;
    description: string;
    /** 稿子 `EMPTY_BY_PAGE` 的原句（空态标题 / 说明）。 */
    empty: { title: string; hint: string };
  }
> = {
  products: {
    title: '商品资料',
    singular: '商品',
    description: '主数据 · 商品建档与定价。无状态列，删除为物理删除。',
    empty: { title: '还没有商品', hint: '先建商品资料与规格，开单时才有东西可选。' },
  },
  customers: {
    title: '客户档案',
    singular: '客户',
    description: '主数据 · 客户资料与对接人，支持查重合并（D98/D103）。',
    empty: { title: '还没有客户', hint: '把客户档建起来并挂上对接人，才能开销售单。' },
  },
  suppliers: {
    title: '供应商档案',
    singular: '供应商',
    description: '主数据 · 供应商资料。销售岗不可见（D4.1）。',
    empty: {
      title: '还没有供应商',
      hint: '录入供应商后，采购单才有下单对象（销售岗默认不可见）。',
    },
  },
  processors: {
    title: '加工厂档案',
    singular: '加工厂',
    description: '主数据 · 外部加工厂与报价记录。记录报价走 processor.create（不是 update）。',
    empty: {
      title: '还没有加工厂',
      hint: '登记外协加工厂后，加工单与它的报价记录都会挂在这里。',
    },
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

/** 档案自身回完整 `contactPhone`；界面上统一显示后 4 位（必做点 3 的脱敏口径）。 */
function maskPhone(phone: string | null): string {
  if (phone === null || phone.length < 4) return '—';
  return `****${phone.slice(-4)}`;
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

/**
 * 金额显示（稿子 `money()`）：`¥` + decimal 字符串原样。
 * 传 `undefined` 表示**后端没给这个键**（无 `view_price`），一律占位「—」，不拿 0 顶。
 */
function moneyText(value: string | undefined): string {
  return value === undefined ? '—' : `¥${value}`;
}

function denyTitle(domain: string, action: ScopeAction): string {
  return `需要 ${domain}.${action} 权限`;
}

function allowTitle(label: string, domain: string, action: ScopeAction): string {
  return `执行「${label}」· 需要 ${domain}.${action} 权限`;
}

/* ------------------------------- 新建 / 编辑表单 ------------------------------- */

function EntityForm({
  kind,
  form,
  editing,
  companyIds,
  companyLabel,
  canViewPrice,
  busy,
  issues,
  domain,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: MasterdataKind;
  form: FormState;
  editing: MasterdataItem | null;
  companyIds: readonly string[];
  companyLabel: (id: string) => string;
  canViewPrice: boolean;
  busy: boolean;
  issues: readonly { path: string; message: string }[];
  domain: string;
  onChange: (field: keyof FormState, value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const copy = PAGE_COPY[kind];
  return (
    <form onSubmit={onSubmit} className="card form-card">
      <div className="card-h">
        <h3>{editing ? `编辑${copy.singular}` : `新建${copy.singular}`}</h3>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          取消
        </button>
      </div>
      <div className="fm">
        <label>
          <span>所属公司</span>
          <select
            value={form.companyId}
            onChange={(event) => onChange('companyId', event.target.value)}
            disabled={editing !== null}
          >
            {companyIds.length === 0 && <option value="">当前账号没有可用公司</option>}
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>名称</span>
          <input
            required
            value={form.name}
            onChange={(event) => onChange('name', event.target.value)}
          />
        </label>
        <label>
          {/* D49：编号是自由文本、可空、不唯一、不作检索主键，只给人看和对账 */}
          <span>编号（可选，仅展示）</span>
          <input value={form.number} onChange={(event) => onChange('number', event.target.value)} />
        </label>

        {kind === 'products' && (
          <>
            <label>
              <span>单位</span>
              <input
                required
                value={form.unit}
                onChange={(event) => onChange('unit', event.target.value)}
              />
            </label>
            <label>
              <span>默认售价</span>
              <input
                inputMode="decimal"
                value={form.defaultSalePrice}
                disabled={!canViewPrice}
                onChange={(event) => onChange('defaultSalePrice', event.target.value)}
                placeholder={canViewPrice ? '如 12.50' : '无看价权限'}
              />
            </label>
            <label className="w">
              <span>别名（逗号分隔）</span>
              <input
                value={form.aliases}
                onChange={(event) => onChange('aliases', event.target.value)}
              />
            </label>
            <label className="w">
              <span>规格</span>
              <input
                value={form.specification}
                onChange={(event) => onChange('specification', event.target.value)}
              />
            </label>
          </>
        )}

        {(kind === 'suppliers' || kind === 'processors' || kind === 'customers') && (
          <label>
            <span>{kind === 'customers' ? '联系人' : '主联系人'}</span>
            <input
              value={form.contactName}
              onChange={(event) => onChange('contactName', event.target.value)}
            />
          </label>
        )}
        {kind === 'customers' && (
          <>
            <label>
              <span>联系电话</span>
              <input
                value={form.contactPhone}
                onChange={(event) => onChange('contactPhone', event.target.value)}
              />
            </label>
            <label>
              <span>账期（天，可空）</span>
              <input
                inputMode="numeric"
                value={form.creditTermDays}
                onChange={(event) => onChange('creditTermDays', event.target.value)}
                placeholder="如 30；留空表示未设置"
              />
            </label>
          </>
        )}
        {kind === 'suppliers' && (
          <>
            <label>
              <span>联系电话</span>
              <input
                value={form.contactPhone}
                onChange={(event) => onChange('contactPhone', event.target.value)}
              />
            </label>
            <label className="w">
              {/* 上限来自契约 `SuppliedMaterialsSchema`：最多 20 项、每项 ≤64 字 */}
              <span>供货物料（逗号分隔，最多 20 项）</span>
              <input
                value={form.suppliedMaterials}
                onChange={(event) => onChange('suppliedMaterials', event.target.value)}
                placeholder="如 纸箱、胶带"
              />
            </label>
          </>
        )}
      </div>

      {issues.length > 0 && (
        <div className="alert alert-bad">
          <h4>有字段没通过校验</h4>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                {issue.path ? `${issue.path}：` : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-acts">
        <button
          type="submit"
          disabled={busy || !form.companyId}
          className="btn pri"
          title={
            editing ? allowTitle('保存修改', domain, 'update') : allowTitle('新建', domain, 'create')
          }
        >
          {busy ? '保存中…' : editing ? '保存修改' : `新建${copy.singular}`}
        </button>
        <span className="detail-why">
          写请求带 <span className="mono">If-Match</span>（乐观锁版本取自列表行）。
        </span>
      </div>
    </form>
  );
}

/* ------------------------------- 加工厂报价面板 ------------------------------- */

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
    <div className="form-sec">
      <div className="form-sec-h">
        <h3>报价记录</h3>
        {/* 口径（D64 ④）：报价只增不改，调价按新日期新增一条，历史行不动 */}
        <span className="sub">只增不改 · 调价按新的生效日期新增一条</span>
      </div>
      <div className="form-sec-b">
        <form
          className="fm c4"
          onSubmit={(event) => {
            event.preventDefault();
            createQuote.mutate();
          }}
        >
          <label>
            <span>生效日期</span>
            <input
              required
              type="date"
              value={quoteDate}
              onChange={(event) => setQuoteDate(event.target.value)}
            />
          </label>
          <label>
            <span>工序</span>
            <input
              required
              value={processName}
              onChange={(event) => setProcessName(event.target.value)}
              placeholder="如 烘焙"
            />
          </label>
          <label>
            <span>单价</span>
            <input
              required
              inputMode="decimal"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
              placeholder="如 1.250000"
            />
          </label>
          <label>
            <span>备注（可选）</span>
            <input
              value={remark}
              onChange={(event) => setRemark(event.target.value)}
              placeholder="如 含税"
            />
          </label>
          <div className="w detail-acts">
            <button
              type="submit"
              disabled={!canQuote || createQuote.isPending}
              title={
                canQuote
                  ? '执行「记录报价」· 需要 processor.create 权限'
                  : '需要 processor.create 权限'
              }
              className="btn pri"
            >
              <Icon name="check" size={14} />
              记录报价
            </button>
            <span className="detail-why">一次报价一行，落表后不可改（D64 ④）。</span>
          </div>
        </form>
        {createQuote.error && (
          <p className="alert alert-bad alert-sm">{errorText(createQuote.error)}</p>
        )}
      </div>

      {/* 报价子表同样走四态（`data-state` 驱动，四块常驻 DOM） */}
      <div
        className="form-sec-b"
        data-state={resolveListState({
          isPending: quotes.isPending,
          hasError: quotes.error !== null,
          isEmpty: (quotes.data?.items.length ?? 0) === 0,
        })}
      >
        <div className="st-block st-filled">
          <div className="ln">
            <table>
              <thead>
                <tr>
                  <th>生效日期</th>
                  <th>工序</th>
                  <th className="num">单价</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {(quotes.data?.items ?? []).map((quote: ProcessorQuote) => (
                  <tr key={quote.id} className="r-row">
                    <td className="mono">{quote.quoteDate}</td>
                    <td>{quote.processName}</td>
                    <td className="num">{quote.unitPrice}</td>
                    <td>{quote.remark ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="st-block st-loading">
          <ListLoading label="报价加载中…" rows={2} />
        </div>
        <div className="st-block st-error">
          <ListError
            title="报价加载失败"
            error={quotes.error ?? null}
            onRetry={() => void quotes.refetch()}
          />
        </div>
        <div className="st-block st-empty">
          <ListEmpty title="还没有报价记录" hint="记录一次报价后，加工单就能引用这个价格。" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- 详情面板 -------------------------------- */

/**
 * 详情面板（#432 必做点 2 / 3 / 4）。
 *
 * 仓库的详情一律是**页内面板**（`OrderDetailUI` 头注释：稿子的 `.drawer` 没搬进来），
 * 所以这里跟采购 / 加工 / 内贸一样用 `<section className="card detail">`。
 *
 * 字段分组固定三块，**没有「备注」组**：四张档案契约都没有备注字段，
 * 画一个空组等于画后端没有的东西。
 */
export function MasterDetail({
  kind,
  item,
  companyLabel,
  domain,
  canUpdate,
  canDelete,
  canViewPrice,
  canQuote,
  onEdit,
  onDelete,
  onClose,
}: {
  kind: MasterdataKind;
  item: MasterdataItem;
  companyLabel: string;
  domain: 'product' | 'supplier' | 'processor' | 'customer';
  canUpdate: boolean;
  canDelete: boolean;
  canViewPrice: boolean;
  canQuote: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const copy = PAGE_COPY[kind];
  const [showContacts, setShowContacts] = useState(false);
  const contactKind: ContactKind | null = kind === 'products' ? null : (kind as ContactKind);

  /* 汇总（单数 / 累计金额 / 最近单据）与对接人都只在**打开一行**时才请求，
     不是每行一次（列表 20 行 × 2 个请求会变成 N+1）。 */
  const summary = useQuery({
    queryKey: ['masterdata', kind, item.id, 'summary'],
    queryFn: () => contactsApi.summary(contactKind as ContactKind, item.id),
    enabled: contactKind !== null,
  });
  const contacts = useQuery({
    queryKey: ['masterdata', kind, item.id, 'contacts'],
    queryFn: () => contactsApi.listContacts(contactKind as ContactKind, item.id),
    enabled: contactKind !== null,
  });

  const info: DocMetaItem[] = [
    { label: `${copy.singular}编号`, value: readNumber(item, kind) ?? '—', mono: true },
    { label: `${copy.singular}名称`, value: <b>{item.name}</b> },
  ];
  if (kind === 'products' && 'specification' in item) {
    info.push({ label: '规格', value: item.specification ?? '—' });
  }
  if (kind === 'products' && 'defaultSalePrice' in item) {
    info.push({
      label: '参考价',
      tone: item.defaultSalePrice === null ? 'dim' : 'money',
      value:
        item.defaultSalePrice === null ? (
          // 无 view_price 时后端把金额置 null（不是 0），一律占位「—」（#432 必做点 6）
          <span className="cell-none" title={formatPrice(null)}>
            —
          </span>
        ) : (
          `¥${item.defaultSalePrice}`
        ),
    });
  }
  if (kind === 'customers' && 'creditTermDays' in item) {
    info.push({
      label: '账期',
      tone: item.creditTermDays === null ? 'dim' : undefined,
      value: item.creditTermDays === null ? '未设置' : `${item.creditTermDays} 天`,
    });
  }
  if (kind === 'suppliers' && 'suppliedMaterials' in item) {
    info.push({
      label: '供货物料',
      value: item.suppliedMaterials.length > 0 ? item.suppliedMaterials.join('、') : '—',
    });
  }
  info.push({ label: '所属公司', value: companyLabel });
  info.push({ label: '最近更新', value: item.updatedAt.slice(0, 10), mono: true });

  const contactGroups = summary.data?.contactGroups ?? [];
  const groupOf = (contactId: string) =>
    contactGroups.find((group) => group.contactId === contactId);
  const summaryData = summary.data;

  // 主数据没有状态列（#315 删了字段），详情头像稿子只给「主数据」这种中性标签，
  // 不做成假状态徽标。
  return (
    <section className="card detail">
      <DetailHead
        docLabel={`${copy.singular}档案`}
        orderNo={readNumber(item, kind) ?? '未编号'}
        pill={<span className="tag">主数据</span>}
        meta={
          <>
            <span>{companyLabel}</span>
            <DetailMetaDot />
            <span>最近更新 {item.updatedAt.slice(0, 10)}</span>
            <DetailMetaDot />
            <span>版本 {item.version}</span>
          </>
        }
        actions={
          <>
            <button
              type="button"
              onClick={onEdit}
              disabled={!canUpdate}
              title={canUpdate ? allowTitle('编辑', domain, 'update') : denyTitle(domain, 'update')}
              className="btn btn-s"
            >
              <Icon name="pencil" size={14} />
              编辑
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={!canDelete}
              title={canDelete ? allowTitle('删除', domain, 'delete') : denyTitle(domain, 'delete')}
              className="btn btn-s"
            >
              <Icon name="trash" size={14} />
              删除
            </button>
          </>
        }
        onClose={onClose}
        closeLabel="收起"
      />

      <h3 className="form-title">基本信息</h3>
      <DocMeta items={info} columns={3} />

      {contactKind !== null && (
        <>
          <h3 className="form-title">联系方式</h3>
          <DocMeta
            items={[
              {
                label: kind === 'customers' ? '联系人' : '主联系人',
                value: readContactName(item) ?? '—',
              },
              {
                label: '联系电话',
                mono: true,
                value:
                  'contactPhone' in item
                    ? maskPhone(item.contactPhone)
                    : '—（加工厂契约无联系电话）',
              },
            ]}
            columns={2}
          />
          <p className="detail-why">
            档案上的电话显示后 4 位；完整号码只在编辑表单里回填，接口按{' '}
            <span className="mono">If-Match</span> 写回。
          </p>

          <div className="detail-acts">
            <h3 className="form-title">对接人</h3>
            <button
              type="button"
              onClick={() => setShowContacts(true)}
              className="btn btn-s act-end"
            >
              <Icon name="trend" size={14} />
              按对接人看流水
            </button>
          </div>
          {contacts.isPending ? (
            <ListLoading label="对接人加载中…" rows={2} />
          ) : contacts.error ? (
            <ListError
              title="对接人加载失败"
              error={contacts.error}
              onRetry={() => void contacts.refetch()}
            />
          ) : (
            <div className="ln">
              <table>
                <thead>
                  <tr>
                    <th>对接人</th>
                    <th>手机号</th>
                    <th>状态</th>
                    <th className="num">单数</th>
                    <th className="num">累计金额</th>
                    <th className="num">最近下单</th>
                  </tr>
                </thead>
                <tbody>
                  {(contacts.data ?? []).map((contact: ContactSummaryRow) => {
                    const group = groupOf(contact.id);
                    return (
                      <tr key={contact.id} className="r-row">
                        <td>
                          <b>{contact.name}</b>
                          {contact.isPrimary && (
                            <span className="tag primary">
                              <Icon name="star" size={11} />
                              主对接人
                            </span>
                          )}
                          {contact.title && <span className="cell-sub">{contact.title}</span>}
                        </td>
                        {/* 手机号只用后端回的 `phoneMasked`，前端不拼明文（必做点 3） */}
                        <td className="mono">{contact.phoneMasked ?? '—'}</td>
                        <td>
                          <span className={contact.status === '启用' ? 'st ok' : 'st idle'}>
                            {contact.status}
                          </span>
                        </td>
                        <td className="num">{group?.orderCount ?? '—'}</td>
                        {/* 无 view_price 时后端不给 totalAmount 键 → 占位「—」，不拿 0 顶 */}
                        <td className="num">{moneyText(group?.totalAmount)}</td>
                        <td className="num mono">{group?.lastOrderAt?.slice(0, 10) ?? '—'}</td>
                      </tr>
                    );
                  })}
                  {(contacts.data ?? []).length === 0 && (
                    <tr className="r-row">
                      <td colSpan={6} className="cell-none">
                        还没有对接人。可在表单里填主联系人，或等开单时自动带出。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="detail-why">
            对接人由服务端判定可见性与脱敏（<span className="mono">phoneMasked</span>
            ）；停用是软停用，历史单据仍可读。
          </p>

          <h3 className="form-title">最近单据</h3>
          {summary.error ? (
            <ListError
              title="汇总加载失败"
              error={summary.error}
              onRetry={() => void summary.refetch()}
            />
          ) : summaryData === undefined ? (
            <ListLoading label="汇总加载中…" rows={2} />
          ) : (
            <>
              <DocMeta
                items={[
                  { label: '单据数', value: summaryData.orderCount, mono: true },
                  {
                    label: '累计金额',
                    tone: summaryData.totalAmount === undefined ? 'dim' : 'money',
                    value: moneyText(summaryData.totalAmount),
                  },
                  {
                    label: '最近下单',
                    value: summaryData.lastOrderAt?.slice(0, 10) ?? '—',
                    mono: true,
                  },
                ]}
                columns={3}
              />
              {summaryData.recentOrders.length > 0 ? (
                <div className="ln">
                  <table>
                    <thead>
                      <tr>
                        <th>单号</th>
                        <th>状态</th>
                        <th className="num">金额</th>
                        <th className="num">下单时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryData.recentOrders.map((order) => (
                        <tr key={order.id} className="r-row">
                          <td className="mono">{order.orderNo}</td>
                          <td>{order.status}</td>
                          <td className="num">{moneyText(order.totalAmount)}</td>
                          <td className="num mono">{order.createdAt.slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="detail-why">这家还没有历史单据。</p>
              )}
              <p className="detail-why">
                后端只回最近 {summaryData.recentOrders.length} 张单（
                <span className="mono">recentOrders</span>
                ），不是全量；按对接人的分组流水见上面的「按对接人看流水」。
              </p>
            </>
          )}
        </>
      )}

      {kind === 'products' && (
        <p className="detail-why">
          商品档案没有对接人（契约无 product contacts）；关联库存批次属库存页（#433），本页不画。
        </p>
      )}

      {kind === 'processors' && (
        <ProcessorQuotes processor={item as Processor} canQuote={canQuote} />
      )}

      {showContacts && contactKind !== null && (
        <ContactDrawer
          kind={contactKind}
          entityId={item.id}
          entityName={item.name}
          entityLabel={copy.singular}
          onClose={() => setShowContacts(false)}
        />
      )}
    </section>
  );
}

/* -------------------------------- 列表页 -------------------------------- */

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
  /** 详情面板：点行打开（稿子 `data-master`），同一时刻只有一行。 */
  const [detail, setDetail] = useState<MasterdataItem | null>(null);

  const me = useQuery({ queryKey: masterdataQueryKeys.me, queryFn: masterdataApi.me });
  const companyIds = me.data?.companyIds ?? [];
  const domain = DOMAIN[kind];
  /** 写入口三态：有权限可点；无权限禁用并在 title 写明缺哪个 scope（不藏按钮）。 */
  const can = (action: ScopeAction) => allows(me.data?.scope, domain, action);
  const canCreate = can('create');
  const canUpdate = can('update');
  const canDelete = can('delete');
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
    onSuccess: async (_data, item) => {
      // 删掉的正是当前详情的这一行：面板要跟着关，不然它显示一个已经不存在的档案
      setDetail((current) => (current?.id === item.id ? null : current));
      await queryClient.invalidateQueries({ queryKey: ['masterdata', kind] });
    },
  });

  const beginCreate = () => {
    setEditing(null);
    setDetail(null);
    setForm({ ...EMPTY_FORM, companyId: companyIds[0] ?? '' });
    setFormOpen(true);
  };
  const beginEdit = (item: MasterdataItem) => {
    setEditing(item);
    setForm(formFromItem(item, kind));
    setFormOpen(true);
    setDetail(item);
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
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });
  const columns = COLUMNS[kind];
  const columnCount = columns.length;
  const filtered = keyword.length > 0 || companyId.length > 0;

  /** 对接人单元格：四页同构（客户 / 供应商 / 加工厂都有 contactName，商品没有该列）。 */
  const contactCell = (item: MasterdataItem) => {
    const name = readContactName(item);
    return name === null || name.length === 0 ? (
      <span className="cell-none">—</span>
    ) : (
      <span className="tag primary">
        <Icon name="star" size={11} />
        {name}
      </span>
    );
  };
  const gapCell = (title: string) => (
    <span className="cell-none" title={title}>
      —
    </span>
  );

  return (
    <section className="page-body">
      {/* 页头（稿子 `head()`：h1 + 副标题 + 右上动作） */}
      <div className="p-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="sub">{copy.description}</p>
        </div>
        <button
          type="button"
          onClick={beginCreate}
          disabled={!canCreate}
          title={canCreate ? allowTitle('新建', domain, 'create') : denyTitle(domain, 'create')}
          className="btn pri"
        >
          <Icon name="check" size={14} />新建{copy.singular}
        </button>
      </div>

      {/* 工具条：稿子 `.tools` 里只有搜索框；公司下拉是 repo 既有的多公司隔离入口，排在其后 */}
      <div className="toolbar">
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={SEARCH_PLACEHOLDER[kind]}
          aria-label={`搜索${copy.title}`}
          className="search"
        />
        {/* 公司筛选：`*ListQuerySchema` 都有 companyId 参数，后端已支持。 */}
        {companyIds.length > 1 && (
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            aria-label="按公司筛选"
            className="sel"
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
          companyLabel={companyLabel}
          canViewPrice={canViewPrice}
          busy={save.isPending}
          issues={issues}
          domain={domain}
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
        <p className="alert alert-bad">{errorText(save.error)}</p>
      )}
      {disable.error && <p className="alert alert-bad">{deleteErrorText(disable.error)}</p>}

      {/*
        列表区（稿子 `tableCard()`）。四态由容器与 tbody 上的 `data-state` 驱动，
        **不写 JSX 分支**：`app-v013.css` 的 `tbody[data-state] > tr.st-tr.st-*` 负责显隐，
        表头宽度不随状态变。数据行只带 `r-row click`（稿子点行开详情），**不要带 `st-tr`**（#337）。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.label} className={column.right ? 'r' : undefined}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={columnCount}>
                  <ListLoading label={`正在加载${copy.title}…`} rows={4} />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={columnCount}>
                  <ListError
                    title={`${copy.title}加载失败`}
                    error={list.error ?? null}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={columnCount}>
                  <ListEmpty
                    title={filtered ? '没有符合条件的记录' : copy.empty.title}
                    hint={filtered ? '换个关键词，或清除筛选条件。' : copy.empty.hint}
                  />
                </td>
              </tr>
              {rows.map((item) => (
                <tr
                  key={item.id}
                  className="r-row click"
                  tabIndex={0}
                  aria-label={`查看${item.name}详情`}
                  onClick={() => setDetail(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDetail(item);
                    }
                  }}
                >
                  <td className="mono">{readNumber(item, kind) ?? '—'}</td>
                  <td>
                    <b>{item.name}</b>
                  </td>
                  {kind === 'products' && 'specification' in item ? (
                    <>
                      <td>{item.specification ?? '—'}</td>
                      <td className="r num">
                        {/* #432 必做点 6：没有 view_price 时金额显示「—」（与稿子 `money()` 同口径），
                            原因放 title，不用长句撑爆 4 列里的钱列。 */}
                        {item.defaultSalePrice === null ? (
                          <span className="cell-none" title={formatPrice(null)}>
                            —
                          </span>
                        ) : (
                          `¥${item.defaultSalePrice}`
                        )}
                      </td>
                    </>
                  ) : kind === 'customers' ? (
                    <>
                      <td>{contactCell(item)}</td>
                      <td>{gapCell(GAP_TITLE.priceList)}</td>
                      <td className="r num">{gapCell(GAP_TITLE.histSales)}</td>
                    </>
                  ) : kind === 'suppliers' ? (
                    <>
                      <td>{contactCell(item)}</td>
                      <td className="r num">{gapCell(GAP_TITLE.histPurchase)}</td>
                    </>
                  ) : (
                    <>
                      <td>{contactCell(item)}</td>
                      <td className="r num">{gapCell(GAP_TITLE.histProcessing)}</td>
                      <td className="r num">{gapCell(GAP_TITLE.quotes)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
          页脚条（稿子 `.tf`：左汇总、右分页）。
          分页用共享的 `BatchPager`：主数据是 `PageQuerySchema` 游标分页、后端不返回 total，
          所以画「上一批 / 第 N 批 / 下一批」，不编「共 N 条」与页码（TODO #341）。
          `.list-card` 在非 filled 态会自动收起右侧分页（`app-v30.css`）。
        */}
        <div className="tf">
          <span>本页 {rows.length} 条</span>
          <BatchPager
            batch={pageIndex + 1}
            hasPrev={pageIndex > 0}
            hasNext={nextCursor !== null}
            onPrev={() => setPageIndex((index) => Math.max(0, index - 1))}
            onNext={() => {
              if (!nextCursor) return;
              setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
              setPageIndex((index) => index + 1);
            }}
            label={`翻${copy.title}`}
          />
        </div>
      </div>

      <p className="detail-why">
        点击行查看详情{kind === 'processors' ? '、报价与对接人' : '与对接人'}。
      </p>

      {detail && (
        <MasterDetail
          kind={kind}
          item={detail}
          companyLabel={companyLabel(detail.companyId)}
          domain={domain}
          canUpdate={canUpdate}
          canDelete={canDelete}
          canViewPrice={canViewPrice}
          canQuote={allows(me.data?.scope, 'processor', 'create')}
          onEdit={() => beginEdit(detail)}
          onDelete={() => askDisable(detail)}
          onClose={() => setDetail(null)}
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
