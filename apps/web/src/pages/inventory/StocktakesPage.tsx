import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../../components/icons/Icon';
import { allows } from '../../lib/access';
import { authApi, authKeys } from '../auth/auth-api';
import { StocktakesPanel } from '../reversals/StocktakesPanel';

/**
 * 库存盘点页（#143）。
 *
 * 复用冲正页的 I 盘点分栏，避免同一套 D47/D67/D71 规则维护两份：
 * - 差异方向与盘盈/盘亏权限拆分；
 * - 创建、详情、强 If-Match 审批；
 * - 审批后刷新批次与流水。
 */
export function StocktakesPage({
  initialFormOpen = false,
}: {
  readonly initialFormOpen?: boolean;
} = {}) {
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const companyIds = me.data?.companyIds ?? [];
  const companyId = selectedCompanyId || companyIds[0] || '';

  return (
    <section className="page-stack">
      <header className="p-head">
        <div>
          <div className="eyebrow">库存 · 盘点</div>
          <h1>盘点</h1>
          <p className="sub">
            盘盈与盘亏分开授权；提交后进入审批。批准会更新库存与流水，驳回只终止审批流。
          </p>
        </div>
        <div className="page-chips">
          <span className="chip icon-chip">
            <Icon name="shield" size={14} /> 强版本校验
          </span>
          <span className="st ok">D71 权限拆分</span>
        </div>
      </header>
      <StocktakesPanel
        canIncrease={allows(me.data?.scope, 'stocktake', 'create')}
        canDecrease={allows(me.data?.scope, 'stocktake', 'delete')}
        canApprove={allows(me.data?.scope, 'stocktake', 'approve')}
        companyIds={companyIds}
        companyId={companyId}
        onCompanyChange={setSelectedCompanyId}
        initialFormOpen={initialFormOpen}
      />
    </section>
  );
}
