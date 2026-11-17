/**
 * 列表四态（v0.13 设计稿的 `data-state`）。
 *
 * 为什么要有这个文件：设计稿里空/加载/错误/有数据四种状态是**同一块 DOM**，
 * 靠容器上的 `data-state="filled|empty|loading|error"` 让 CSS 决定显示哪个子块
 * （见 `styles/app-v013.css` 的 `.st-block` / `.st-tr` 规则）。
 *
 * 反面写法（**不要用**）：`{rows.length === 0 ? <EmptyRow/> : rows.map(...)}`。
 * 那样表格的 `<tbody>` 里只剩一行「暂无数据」，列数塌成 1 列，单元格对不齐；
 * 而且那一行拿不到设计稿给状态行准备的样式（`.st-*` 系列类名是按 `data-state`
 * 选择器写的，不是按行内容写的）。
 *
 * 所以页面只算一个字符串交给容器属性，**渲染分支交给 CSS**。
 */

export type ListState = 'filled' | 'empty' | 'loading' | 'error';

/**
 * 把 react-query 三件套压成一个状态。
 *
 * 优先级之所以是 loading → error → empty → filled：react-query 在 refetch 期间
 * `isPending` 与 `error` 可能同时为真（上一轮失败、这一轮还在重试），先判 loading
 * 才不至于画面在「错误」和「加载中」之间闪。
 */
export function resolveListState(input: {
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly isEmpty: boolean;
}): ListState {
  if (input.isPending) return 'loading';
  if (input.hasError) return 'error';
  if (input.isEmpty) return 'empty';
  return 'filled';
}

/**
 * 表格行的 `data-state`：只有 `filled` 时数据行可见。
 *
 * 单独给行用是因为设计稿对表格做的是 `tbody > tr.st-tr{display:none}` +
 * `tbody[data-state="filled"] > tr.st-tr.r-row{display:table-row}`：
 * 状态行（`st-empty` / `st-loading` / `st-error`）与数据行都在同一个 `tbody` 里，
 * 靠 `data-state` 决定谁显示。这样表头宽度不受状态切换影响。
 */
export function rowState(state: ListState): ListState {
  return state;
}
