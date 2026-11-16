/**
 * `/settings` 的落地页骨架（#300 只做入口与路由；设置页内部面板归 #299）。
 *
 * 这里**不画任何设置项**：新版设置中心的面板（我的资料 / 账号安全 / 公司资料…）
 * 由 #299 在 `apps/web/src/pages/settings/**` 实现后替换本占位组件。
 * 现在只保证「设置入口可点、路由可达、不 404」。
 */
export function SettingsEntryPlaceholder() {
  return (
    <section className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">设置中心</h1>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
          面板建设中
        </span>
      </div>
      <p className="mt-3 text-sm text-slate-600">
        入口与路由已就位；个人资料、账号安全、外观、公司资料等面板由 #299 落地。
      </p>
      <p className="mt-2 text-xs text-slate-400">
        这里只显示你自己能看的内容；权限判定一律以接口为准，前端隐藏不算授权。
      </p>
    </section>
  );
}
