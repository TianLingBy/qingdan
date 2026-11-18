import type { SettingsOverview } from '@qingdan/contracts';
import { ApiClient, apiClient } from '../../api/client';

/**
 * 设置中心（#343 / D93）的 API 薄封装。
 *
 * 只有一个端点：`GET /api/v1/settings/overview`（契约 `packages/contracts/src/settings.ts`，
 * operationId `platform.settings.overview`，domain=platform，action=read）。
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
  };
}

export const settingsApi = createSettingsApi();
