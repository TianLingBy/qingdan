import type { ServiceRegistry } from '../../../platform/services/registry.js';

/**
 * platform 对外端口实现（D70）。
 *
 * 员工/岗位/公司是 platform 的表，其它模块（如 settlement 的提成配置）要用
 * 「这个员工是否属于这家公司」时走这个端口，**不直读 `employee_company_position`**
 * （模块边界铁律，AGENTS.md「禁止事项」）。
 */
export const platformServices: Pick<ServiceRegistry, 'employeeDirectory'> = {
  employeeDirectory: {
    belongsToCompany: async (tx, query) => {
      const result = await tx.query<{ belongs: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM employee_company_position
            WHERE tenant_id = $1
              AND company_id = $2::uuid
              AND employee_id = $3::uuid
         ) AS belongs`,
        [query.tenantId, query.companyId, query.employeeId],
      );
      return result.rows[0]?.belongs === true;
    },
  },
};
