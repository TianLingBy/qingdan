import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ListError, ListLoading } from '../../components/ListStates';
import { contactsApi, type ContactFull, type ContactKind } from './contacts-api';

/**
 * 对接人抽屉（#306 / 改稿清单 §三）：客户 / 供应商 / 加工厂三页同构。
 *
 * 三级下钻：档案页 → 本抽屉（对接人列表） → 单个对接人的订单。
 *
 * 口径：
 * - **「未指定对接人」组必须显示**（`contactId === null`）——丢了这组，
 *   各分组 orderCount 加起来会小于总数，看的人会以为丢单；
 * - 金额没有 `view_price` 时后端**不给 `totalAmount` 键**，一律显示占位符 `—`，
 *   不能读成 0、不能报错；
 * - 订单只显示后端返回的 `recentOrders`（最多 10 张，契约已写死），不是全量列表，
 *   所以页头要写明「最近 10 张单」，别让人以为这就是全部。
 */
interface ContactDrawerProps {
  readonly kind: ContactKind;
  readonly entityId: string;
  readonly entityName: string;
  /** 档案中文名：客户 / 供应商 / 加工厂。 */
  readonly entityLabel: string;
  readonly onClose: () => void;
}

/** 未指定对接人在 contractId 上是 null，用一个哨兵值区分「没选中」与「选中了 null 组」。 */
const NO_CONTACT = '__no_contact__';

function moneyText(value: string | undefined): string {
  return value === undefined ? '—' : value;
}

function dayText(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/** summary 的 `contacts` 是详情口径（带完整 phone），抽屉里一律脱敏显示后 4 位。 */
function maskPhone(phone: string | null): string {
  if (phone === null || phone.length < 4) return '—';
  return `****${phone.slice(-4)}`;
}

export function ContactDrawer({
  kind,
  entityId,
  entityName,
  entityLabel,
  onClose,
}: ContactDrawerProps) {
  const [selected, setSelected] = useState<string | typeof NO_CONTACT | null>(null);

  const summary = useQuery({
    queryKey: ['masterdata', kind, entityId, 'contact-summary'],
    queryFn: () => contactsApi.summary(kind, entityId, { groupByContact: true }),
  });

  const profileById = new Map<string, ContactFull>(
    (summary.data?.contacts ?? []).map((contact) => [contact.id, contact] as const),
  );

  /** 有分组就按分组画；没分组（后端未回）就退回档案上的对接人，单数记 0。 */
  const groups =
    summary.data?.contactGroups ??
    (summary.data?.contacts ?? []).map((contact) => ({
      contactId: contact.id as string | null,
      contactName: contact.name as string | null,
      orderCount: 0,
      totalAmount: undefined,
      lastOrderAt: null,
    }));

  /** 未指定对接人组排最后：它不是一个真实的人，放中间会打断阅读。 */
  const ordered = [...groups].sort((a, b) => {
    if (a.contactId === null) return 1;
    if (b.contactId === null) return -1;
    return b.orderCount - a.orderCount;
  });

  const selectedGroup =
    selected === null
      ? null
      : (ordered.find((group) => (group.contactId ?? NO_CONTACT) === selected) ?? null);

  const selectedOrders = (summary.data?.recentOrders ?? []).filter((order) => {
    if (selectedGroup === null) return false;
    return order.contactId === selectedGroup.contactId;
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20">
      <button type="button" aria-label="关闭对接人抽屉" onClick={onClose} className="flex-1 cursor-default" />
      <aside className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-semibold">
              {selectedGroup === null
                ? `${entityName} · 对接人`
                : `${selectedGroup.contactName ?? '未指定对接人'} · 最近订单`}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {selectedGroup === null
                ? `${entityLabel}对接人、单数与累计金额（金额需看价权限）`
                : '仅显示后端返回的最近 10 张单，不是全量订单'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {selectedGroup !== null && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-slate-300 px-2.5 py-1 text-xs"
              >
                返回对接人
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-300 px-2.5 py-1 text-xs"
            >
              关闭
            </button>
          </div>
        </header>

        <div className="px-5 py-4">
          {summary.isPending ? (
            <ListLoading label="对接人加载中…" rows={3} />
          ) : summary.error ? (
            <ListError
              title="对接人加载失败"
              error={summary.error}
              onRetry={() => void summary.refetch()}
            />
          ) : selectedGroup === null ? (
            <>
              <dl className="mb-4 grid grid-cols-3 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">单据数</dt>
                  <dd className="mt-0.5 font-medium">{summary.data.orderCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">累计金额</dt>
                  <dd className="mt-0.5 font-medium">{moneyText(summary.data.totalAmount)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">最近下单</dt>
                  <dd className="mt-0.5 font-medium">{dayText(summary.data.lastOrderAt)}</dd>
                </div>
              </dl>

              {ordered.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                  还没有对接人。可在表单里填主联系人，或等开单时自动带出。
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">对接人</th>
                        <th className="px-3 py-2 font-medium">手机号</th>
                        <th className="px-3 py-2 font-medium">状态</th>
                        <th className="px-3 py-2 font-medium">单数</th>
                        <th className="px-3 py-2 font-medium">累计金额</th>
                        <th className="px-3 py-2 font-medium">最近下单</th>
                        <th className="px-3 py-2 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ordered.map((group) => {
                        const profile =
                          group.contactId === null ? undefined : profileById.get(group.contactId);
                        const key = group.contactId ?? NO_CONTACT;
                        return (
                          <tr key={key} className="border-t border-slate-100">
                            <td className="px-3 py-2">
                              {group.contactId === null ? (
                                <span className="text-slate-500">未指定对接人</span>
                              ) : (
                                <>
                                  <span className="font-medium">
                                    {group.contactName ?? profile?.name ?? '—'}
                                  </span>
                                  {profile?.isPrimary && (
                                    <span className="ml-1.5 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-white">
                                      主
                                    </span>
                                  )}
                                  {profile?.title && (
                                    <span className="ml-1.5 text-xs text-slate-400">{profile.title}</span>
                                  )}
                                </>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-500">
                              {profile === undefined ? '—' : maskPhone(profile.phone)}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-500">
                              {profile?.status ?? '—'}
                            </td>
                            <td className="px-3 py-2">{group.orderCount}</td>
                            {/* 无 view_price 时 totalAmount 键不存在 → 占位符 «—»，不给 0 */}
                            <td className="px-3 py-2">{moneyText(group.totalAmount)}</td>
                            <td className="px-3 py-2 text-xs text-slate-500">
                              {dayText(group.lastOrderAt)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => setSelected(key)}
                                className="rounded border border-slate-300 px-2 py-1 text-xs"
                              >
                                查看订单
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : selectedOrders.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
              最近 10 张单里没有这一位的单。
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">单号</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">金额</th>
                    <th className="px-3 py-2 font-medium">下单时间</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrders.map((order) => (
                    <tr key={order.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs">{order.orderNo}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">{order.status}</td>
                      {/* 同样：键不存在 = 无看价权限，显示 «—» */}
                      <td className="px-3 py-2">{moneyText(order.totalAmount)}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {order.createdAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
