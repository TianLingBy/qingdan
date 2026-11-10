import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { allows } from '../../lib/access';
import { authApi, authKeys } from '../auth/auth-api';
import { StocktakesPanel } from '../reversals/StocktakesPanel';
import { PageShell } from './inventory-ui';

/**
 * 库存盘点页（#143）。
 *
 * 复用冲正页的 I 盘点分栏，避免同一套 D47/D67/D71 规则维护两份：
 * - 差异方向与盘盈/盘亏权限拆分；
 * - 创建、详情、强 If-Match 审批；
 * - 审批后刷新批次与流水。
 */
export function StocktakesPage() {
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const companyIds = me.data?.companyIds ?? [];
  const companyId = selectedCompanyId || companyIds[0] || '';

  return (
    <PageShell
      title="盘点"
      description="盘盈与盘亏分开授权；提交后进入审批，审批通过再追加冲正流水。"
    >
      <StocktakesPanel
        canIncrease={allows(me.data?.scope, 'stocktake', 'create')}
        canDecrease={allows(me.data?.scope, 'stocktake', 'delete')}
        canApprove={allows(me.data?.scope, 'stocktake', 'approve')}
        companyIds={companyIds}
        companyId={companyId}
        onCompanyChange={setSelectedCompanyId}
      />
    </PageShell>
  );
}
