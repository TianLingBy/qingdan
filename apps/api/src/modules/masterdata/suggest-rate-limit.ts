/**
 * suggest 端点的进程内限流（D99 / #302 块 B）。
 *
 * 为什么要有：这个接口是「输入框边打边问」，天然允许高频；但没有上限时，一个持 read 权限的
 * 调用方可以拿短名字 + `limit=20` 反复扫，把本公司客户名分批捞走（虽然 `customer.list.read`
 * 本来就能翻全表，见 D99 的说明）。30 次/分钟足够真人打字——人不会比这更快。
 *
 * 为什么按 principal 而不是 IP：一个办公室共用一个出口 IP，按 IP 限流会误伤整间办公室。
 *
 * 为什么是进程内滑动窗口：不引依赖、不引 Redis，单实例部署够用。多实例部署时这里会退化成
 * 「每个实例各 30 次/分钟」——届时换成 Redis 计数或按实例数分片即可，接口形状不用变。
 */

/** 统计窗口（毫秒）。 */
export const SUGGEST_RATE_WINDOW_MS = 60_000;
/** 窗口内允许的请求数。 */
export const SUGGEST_RATE_LIMIT = 30;
/** 超过这么多 key 就顺手清掉窗口外的旧打点，避免 Map 无限增长。 */
const SWEEP_THRESHOLD = 1_000;

/** key（principal 的 actorId）→ 窗口内的请求时刻。 */
const hits = new Map<string, number[]>();

/**
 * 取一个配额：配额内记一次并返回 true，超限返回 false。
 * `nowMs` 可注入，测试不必真的等一分钟。
 */
export function takeSuggestQuota(key: string, nowMs: number = Date.now()): boolean {
  const cutoff = nowMs - SUGGEST_RATE_WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((at) => at > cutoff);
  if (recent.length >= SUGGEST_RATE_LIMIT) {
    // 顺手把过期打点写回，既是裁剪也让 idle 的 key 只占一条空数组。
    hits.set(key, recent);
    return false;
  }
  recent.push(nowMs);
  hits.set(key, recent);
  if (hits.size > SWEEP_THRESHOLD) sweep(cutoff);
  return true;
}

/** 清掉所有窗口外已无打点的 key（被限流的 key 会留一条空数组，下次请求即被回收）。 */
function sweep(cutoff: number): void {
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1]! <= cutoff) hits.delete(key);
  }
}

/** 测试用：清空所有配额。 */
export function resetSuggestQuota(): void {
  hits.clear();
}
