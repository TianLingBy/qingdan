import type {
  SettingsOverview,
  SettingsSessionList,
  SettingsSessionRevokeResult,
} from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

/**
 * 设置中心（#343 / D93）的 API 薄封装。
 *
 * 三个端点（契约 `packages/contracts/src/settings.ts`）：
 * - `GET /api/v1/settings/overview`（`platform.settings.overview`，platform.read）—— 五块正文一次拿全
 * - `GET /api/v1/employees/me/sessions`（`platform.settings.sessions`，employee.read）—— 我的登录设备
 * - `DELETE /api/v1/employees/me/sessions/{id}`（`platform.settings.revoke_session`，employee.update）
 *
 * 后两个为什么不并进 overview：会话是**会变的**（别处刚登录就多一条），而概览是配置类
 * 快照。混在一起会让「踢掉一台设备后整页重新加载」，也会让 60 秒的 staleTime 卡住刚踢完的视图。
 *
 * 为什么是一个聚合端点而不是五个：设置中心是「打开就要全看到」的首屏，
 * 拆成五个请求会让五个区块各自闪一次骨架；后端一次算完更好控制一致性
 * （`me.companies` 与顶层 `companies` 同源，分两次请求就可能不同源）。
 *
 * 为什么封装成工厂而不是直接写 `client.get`：现有页面的写法不统一（有的直接调 client、
 * 有的走 api 模块），测试需要注入假的 fetch，工厂模式让 `createSettingsApi(recorder)`
 * 能单独测请求形状而不必渲染组件。
 */

export function createSettingsApi(client: ApiClient = apiClient) {
  return {
    /**
     * 概览。没有 `company.read` 时后端返回 **403**（不是空数组）——
     * 调用方必须把 403 当正常分支处理，渲染成「没有权限」而不是「没有公司」。
     */
    overview: () => client.get<SettingsOverview>('/settings/overview'),

    /**
     * 我的登录会话。**已吊销的也一并返回** —— 后端注释写明理由：「『我刚踢了谁』有据可查」。
     * 调用方不要过滤掉 `revokedAt !== null` 的行，那是用户确认自己操作生效的唯一凭据。
     */
    sessions: () => client.get<SettingsSessionList>('/employees/me/sessions'),

    /**
     * 踢掉我的一条会话。
     *
     * **只限本人**：id 不属于本人时后端回 **403**（不是 404）—— 注解见
     * `apps/api/src/modules/platform/usecases/settings-sessions.ts:167`：「不存在与非本人
     * 同等对待，别让 404/403 的差异泄漏『这条 session 存在』」。所以提示文案统一写
     * 「只能撤销本人的登录会话」，不要写「这条会话不存在」。
     */
    revokeSession: (id: string) =>
      client.delete<SettingsSessionRevokeResult>(`/employees/me/sessions/${id}`),
  };
}

export const settingsApi = createSettingsApi();
