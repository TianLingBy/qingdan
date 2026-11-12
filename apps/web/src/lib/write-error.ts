/**
 * 写操作失败的统一口径（单据 A/B/E/N/C 五页共用）。
 *
 * 为什么单独抽出来：
 *   1. 服务端错误码是封闭枚举（`packages/contracts` 的 `ERROR_CODES`），前端各页原先各写一份
 *      `errorText`，文案口径不一致，有的直接抛 `message（CODE）`，用户看不懂该做什么；
 *   2. 更关键的是**版本冲突会把人卡死**：改单 / 确认结算用的是点「编辑」时抓的快照 `version`，
 *      一旦别人先改过（409 VERSION_CONFLICT），表单里的 version 不会自愈——用户再点保存还是同一个错，
 *      关掉重开又会丢掉已填内容。`recoverFromStaleVersion` 负责把最新 version 取回来接上，
 *      让用户「核对后再点一次保存」就能过（D60：写操作强制 If-Match）。
 */
import { ApiError } from '../api/client';

/** 页面数据过期：409 版本冲突，或 428 缺 `If-Match`（两者都意味着「按旧版本写」）。 */
export function isStaleVersionError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 428) return true;
  return error.status === 409 && error.code === 'VERSION_CONFLICT';
}

/**
 * 写操作失败的人话文案。
 *
 * 已知码给「下一步该干什么」，未知码保留服务端 message 与 code（便于贴给后端定位）。
 * `fallback` 供非 ApiError（网络中断、前端自己 throw）时兜底。
 */
export function describeWriteError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error && error.message !== '' ? error.message : fallback;
  }
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return '这张单已被别人改过（版本过期），请重新读取后再保存';
    case 'PRECONDITION_REQUIRED':
      return '页面数据已过期（缺版本头），请刷新后再保存';
    case 'IDEMPOTENCY_CONFLICT':
      return '这次提交与上一次重复且内容不同，请刷新后重试';
    case 'FORBIDDEN':
      return '当前身份没有该操作权限，请联系老板开通';
    case 'NOT_IMPLEMENTED':
      return '服务端还没实现这个操作（501），请先别用';
    case 'UNAUTHENTICATED':
      return '登录已失效，请重新登录';
    default:
      return `${error.message}（${error.code}）`;
  }
}

/**
 * 版本冲突后取回最新单据，把 `version` 接上。
 *
 * 返回 `null` 表示「不用处理」或「取最新也失败」——两种情况都保留原始报错，不叠加噪音。
 * 调用方拿到 `fresh` 后：`setEditing({ ...editing, version: fresh.version })` + 提示用户核对后重存。
 */
export async function recoverFromStaleVersion<Detail extends { readonly version: number }>(
  error: unknown,
  orderId: string | null,
  load: (id: string) => Promise<Detail>,
): Promise<Detail | null> {
  if (orderId === null || !isStaleVersionError(error)) return null;
  try {
    return await load(orderId);
  } catch {
    return null;
  }
}

/** 自愈成功后的提示（各页共用同一句话，避免表述漂移）。 */
export function staleVersionRecoveredText(version: number): string {
  return `这张单已被别人改过，已同步到最新版本 v${version}；你填的内容还在，请核对后再次保存。`;
}

/**
 * 破坏性操作（取消 / 完成）撞版本冲突后的提示。
 *
 * 与「保存」不同：这里没有用户填的内容要保留，而是**单据状态可能已经变了**
 * （别人先取消了、先完成了），所以不自动重提，让用户先看清最新状态再决定（D60）。
 */
export function staleActionRetryText(version: number, action: string): string {
  return `这张单刚被别人改过，已同步到最新版本 v${version}。请核对单据当前状态，再点一次「${action}」。`;
}

/**
 * 版本冲突、但**没能读回最新单据**（网络中断 / 权限被撤）时的兜底。
 *
 * 这条分支原本是死的：`recoverFromStaleVersion` 返回 null 后页面 `return` 了，
 * 而红条的渲染条件带 `!isStaleVersionError`，amber 提示又没设——用户看到的就是「点了没反应」。
 * stale 类错误不能既不给红条也不给琥珀条，必须有一句话说清。
 */
export function staleUnrecoveredText(): string {
  return '这张单刚被别人改过，但没能读取到最新版本（可能是网络或权限问题）；请刷新页面后重新操作。';
}
