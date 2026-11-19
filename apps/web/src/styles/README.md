# apps/web/src/styles —— 两套设计令牌并存说明

这份目录在 2026-11-17 之后同时装着两套样式：老的 v0.8 与新的 v0.13。**这是过渡期的临时状态，不是长期设计。**

## 文件清单

| 文件 | 来源 | 谁在用 |
|---|---|---|
| `tokens.css`（6.9KB） | v0.8 设计稿，2026-11-08 落地 | 现有全部页面。变量名 `--qd-*` / `--color-*` / `--radius-*` / `--text-*` / `--ease-*` |
| `tokens-v013.css`（5.7KB） | `design/v0.13/tokens.css` | 重做中的 23 页。变量名 `--bg-*` / `--text-*` / `--r-*` / `--fs-*` / `--ease-*` |
| `app-v013.css`（42KB，584 行） | `design/v0.13/app.css` | 同上。221 个组件类，如 `.panel` `.table` `.btn` `.badge` `.pager` |

两套令牌的**变量名零交集**（已用脚本核过：v0.8 有 72 个、v0.13 有 71 个，互相不覆盖），所以可以同时 `@import` 进 `index.css`，老页面继续吃 v0.8，新页面吃 v0.13。

`apps/web/src/index.css` 现在长这样：

```css
@import "tailwindcss";
@import "./styles/tokens.css";        /* v0.8，老页面 */
@import "./styles/tokens-v013.css";   /* v0.13，新页面 */
@import "./styles/app-v013.css";      /* v0.13，新页面 */
```

## 与设计稿原文件的两处差异（别改回去）

### 1. `tokens-v013.css` 删掉了外网字体

设计稿第 11 行是：

```css
@import url("https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css");
```

车间和仓库的内网连不上 jsdelivr。留着这条，浏览器要等这个请求超时（默认 30 秒）才渲染首屏文字。已删，字体回落到 tokens 里 `--sans` 声明的本地字体栈。

### 2. `app-v013.css` 删掉了五条会波及老页面的全局规则

设计稿是「整站只有这一套样式」，所以它敢写全局 reset。现在老页面还在跑，这五条会把它们砸掉：

| 原行 | 原文 | 为什么必须删 |
|---|---|---|
| L10 | `html{background:var(--bg-0)}` | 现有页面底色会被压成暗色 `#0A0E0C` |
| L149 | `*{box-sizing:border-box;margin:0;padding:0}` | 所有元素的 margin/padding 清零，现有页面间距全没 |
| L150 | `a{color:inherit;text-decoration:none}` | 现有链接下划线消失 |
| L151 | `button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}` | 现有按钮的底色与边框被抹掉 |
| L247 | `body{...display:flex;font-size:16px;line-height:1.7;overflow-x:hidden}` | body 变 flex，整站子元素流改变 |

这五条在老页面退场之后应该加回来。判断时机：**23 页全部合并、`apps/web/src/pages` 里不再有 Tailwind 工具类写的布局时**。

## 四态怎么用（这是 v0.13 最容易被改坏的地方）

设计稿把四种状态（有数据 / 空 / 加载中 / 出错）做成**同一条 DOM，靠 CSS 切显示**，不是靠 JS 条件渲染。你写 React 时**只改容器上的 `data-state` 属性**，四个分支的内容平时都渲染在 DOM 里、由 CSS 决定哪个可见。

### 块级（面板、卡片、详情区）

```tsx
<section className="panel" data-state={state}>
  <div className="st-block st-filled">…真实内容…</div>
  <div className="st-block st-empty">…空态文案…</div>
  <div className="st-block st-loading">…骨架屏…</div>
  <div className="st-block st-error">…错误文案 + 重试按钮…</div>
</section>
```

`state` 取 `'filled' | 'empty' | 'loading' | 'error'`，直接来自 `useQuery` 的 `isPending` / `isError` / 数据是否为空。

CSS 规则（`app-v013.css:17-24`）：

```css
[data-state] > .st-block{display:none}
[data-state="filled"] > .st-filled,
[data-state="empty"] > .st-empty,
[data-state="loading"] > .st-loading,
[data-state="error"] > .st-error{display:block}
[data-state="empty"] > .st-filled,
[data-state="loading"] > .st-filled,
[data-state="error"] > .st-filled{display:none}
```

### 表格（列表页最常用）

`data-state` 挂在 `<tbody>` 上，真实数据行带 `r-row`，三种状态行带 `st-tr st-*`：

```tsx
<tbody data-state={state}>
  {rows.map((r) => (
    <tr key={r.id} className="r-row">
      <td>…</td>
      <td className="num">…</td>
    </tr>
  ))}
  <tr className="st-tr st-empty">
    <td colSpan={9}>还没有单据。点右上「新建销售单」开始。</td>
  </tr>
  <tr className="st-tr st-loading">
    <td colSpan={9}>加载中…</td>
  </tr>
  <tr className="st-tr st-error">
    <td colSpan={9}>加载失败：{err.message}</td>
  </tr>
</tbody>
```

CSS 规则（`app-v013.css:25-31`）：

```css
tbody > tr.st-tr{display:none}
tbody[data-state="empty"] > tr.r-row,
tbody[data-state="loading"] > tr.r-row,
tbody[data-state="error"] > tr.r-row{display:none}
tbody[data-state="empty"] > tr.st-tr.st-empty,
tbody[data-state="loading"] > tr.st-tr.st-loading,
tbody[data-state="error"] > tr.st-tr.st-error{display:table-row}
```

**别写成 `{!rows.length && <EmptyRow/>}`。** 那样三种状态行在切换时会挂载/卸载，`colSpan` 与列数一旦对不上，表格会塌成两列；而且设计稿里状态行的背景、上边距、字号是这一套 CSS 给的，条件渲染等于绕开它。

## 常用类名（写页面前对着抄）

| 用途 | 类名 |
|---|---|
| 页面骨架 | `shell` → `sidebar` / `main` → `topbar` + `wrap` |
| 侧栏 | `sidebar`、`brand`、`sb-nav`、`sb-domain`、`sb-link`（当前页加 `on`） |
| 顶栏 | `topbar`、`crumb`（含 `sep` / `cur`）、`snapshot`、`actions` |
| 区块容器 | `panel`（`--bg-1` 底 + `--r-panel` 圆角 + `--line-1` 描边）、`panel-h` 标题行 |
| 列表容器 | `card`（`app-v013.css` 里带 `table` / `thead th` / `tbody td` 的内边距规则，五张单据页都用它）。**自带 `overflow:hidden`**：表格要横向滚动必须套一层 `overflow-x-auto`，否则是直接裁断而不是出滚动条 |
| 表格 | `table`、`num`（等宽数字列）、`thead th` 已 sticky |
| 按钮 | `btn` + `btn-p`（主要）/ `btn-s`（次要）/ `btn-ghost`（幽灵）/ `btn-g`（危险），尺寸 `btn-g` |
| 状态徽章 | `badge` + `st-*` 语义色，或 `chip` |
| 汇总数字 | `kpi`、`bar`、`chartbox`、`chart-head` |
| 分页条 | `pager`（内含 `of`、页码按钮） |
| 空态 | `empty`、`empty-ico`、`empty-actions` |

完整 221 个类名看 `app-v013.css`。

## 不要用的类名

- **`.cards` / `.cards-view`**：**卡片视图切换控件**。`.cards` 默认 `display:none`，只有挂在 `.card.cards-view` 下才显示成网格。别当容器用 —— 容器用上面的 `card`（列表）或 `panel`（区块）。
- **`.card-h` / `.card-sub`**：卡片标题 / 副标题的**文字样式**，不是容器。
- **`.d` / `.a` / `.s` / `.c`**：这是**权限字母**（删 / 增 / 查 / 改）的缩写，别当尺寸类用。
- **`.drag-tip` / `.code-btn` / `.comp-row` / `.comp-eq`**：这几组是设计稿里「演示/说明」专用，产品页不需要。
- **任何直接写死颜色值**：一律走 `var(--*)`。设计稿的 `!important` 只用在亮色主题覆盖、圆角规范、reduced-motion、打印这四处，你新写的样式不该出现 `!important`。

## 验收

改完任何一页，在本机跑：

```powershell
pnpm -r build
pnpm -r test
pwsh -NoProfile -File tests/run.ps1
```

`apps/web` 的用例（45 文件 / 414 条）里有一条 `browser-baseline.test.ts` 校验浏览器基线，别动它。
