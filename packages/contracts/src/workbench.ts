import { z } from 'zod';

/**
 * 工作台入口（Issue #227）：
 * 身份与入口清单由后端按账号 scope 现算后随 `/auth/me` 下发，前端不再自行推导。
 *
 * 字段与 web 路由表 `RouteSpec` 对齐（id / path / page / title / domain），
 * 便于前端逐步从「本地 ROUTE_TABLE 推导」切换为「消费 /auth/me 下发清单」。
 */
export const WorkbenchEntrySchema = z.object({
  /** 稳定 id，与 web 路由表一致，用于测试与埋点。 */
  id: z.string(),
  /** kebab-case 路径。 */
  path: z.string(),
  /** 页面全名（与 IA 22 页对齐）。 */
  page: z.string(),
  /** 短标题（入口卡片 / 导航用）。 */
  title: z.string(),
  /** 功能域分组（公共 / 单据与结算 / 冲正 / 主数据 / 库存 / 组织 / 报表 / 系统）。 */
  domain: z.string(),
});

export type WorkbenchEntry = z.infer<typeof WorkbenchEntrySchema>;

export const WorkbenchEntryListSchema = z.array(WorkbenchEntrySchema);
