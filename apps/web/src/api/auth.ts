/**
 * 认证 API（契约：`platform.auth.login` / `platform.auth.logout` / `platform.auth.me`）
 *
 * 会话形态：服务端登录成功后下发 HttpOnly 会话 Cookie（apps/api `cookie.ts`），
 * Web 端不持有也不存储 token——`apiClient.getToken` 保持返回 null，不发送 Authorization。
 * Cookie 走同源（dev 下 Vite 代理 /api → 127.0.0.1:3000），写操作的
 * Origin/Referer 同源校验由浏览器自动满足。
 *
 * 一期口径（D54④，模块文档「验收标准 · 登录闭环」）：
 *   账号由后台/初始化脚本创建，本页只做「手机号 + 验证码 → 登录 / 登出」；
 *   企业注册与入企三合一端点推迟到上线前，前端不预留表单。
 */

import { apiClient } from './client';

/** 登录请求体（契约 `LoginInput`：phone 6-32 位、code 1-16 位）。 */
export interface LoginInput {
  phone: string;
  code: string;
}

/** 登录响应（契约 `LoginOutput`）。 */
export interface LoginOutput {
  employeeId: string;
  tenantId: string;
  displayName: string;
}

/** 当前登录主体与生效权限（契约 `MeOutput`，scope 结构见 `packages/contracts/src/authz.ts`）。 */
export interface SessionUser {
  employeeId: string;
  tenantId: string;
  displayName: string;
  /** 数据可见范围 = 绑定公司集合（D15）。 */
  companyIds: string[];
  /** 功能域 × 动作矩阵（D4/D50），服务端每请求现算，前端只做展示不做判定。 */
  scope: { domain: string; actions: string[] }[];
}

/** 登录。成功后会话 Cookie 已由服务端 Set-Cookie 下发。 */
export function login(input: LoginInput, client = apiClient): Promise<LoginOutput> {
  return client.post<LoginOutput>('/auth/login', input);
}

/** 登出（幂等，只失效当前会话并清 Cookie）。 */
export function logout(client = apiClient): Promise<void> {
  return client.post<void>('/auth/logout');
}

/** 查询当前会话；未登录时服务端返回 401 `UNAUTHENTICATED`。 */
export function fetchMe(client = apiClient): Promise<SessionUser> {
  return client.get<SessionUser>('/auth/me');
}
