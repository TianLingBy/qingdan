# apps/web/src/styles —— 三套样式并存的过渡期说明

这份目录在 2026-11-24 之后同时装着三套样式：老的 v0.8、过渡的 v0.13、以及 v3.0 底座。**这是过渡期的临时状态，不是长期设计。**

## 文件清单

| 文件 | 来源 | 谁在用 |
|---|---|---|
| `tokens.css`（6.9KB） | v0.8 设计稿，2026-11-08 落地 | 现有全部页面。变量名 `--qd-*` / `--color-*` / `--radius-*` / `--text-*` / `--ease-*` |
| `tokens-v013.css`（5.7KB） | `design/v0.13/tokens.css` | 重做中的 23 页。变量名 `--bg-*` / `--text-*` / `--r-*` / `--fs-*` / `--ease-*` |
| `app-v013.css`（42KB，584 行） | `design/v0.13/app.css` | 同上。221 个组件类，如 `.panel` `.table` `.btn` `.badge` `.pager` |
| `app-v30.css`（约 20KB） | `design/v3.0/index.html` 的 `<style>` 段（#443） | 五批 v3.0 页面改造共用的底座。只含下面 §v3.0 底座 列的那几组 |

两套令牌的**变量名零交集**（已用脚本核过：v0.8 有 72 个、v0.13 有 71 个，互相不覆盖），所以可以同时 `@import` 进 `index.css`，老页面继续吃 v0.8，新页面吃 v0.13。

`apps/web/src/index.css` 现在长这样：

```css
@import "tailwindcss";
@import "./styles/tokens.css";        /* v0.8，老页面 */
@import "./styles/tokens-v013.css";   /* v0.13，新页面 */
@import "./styles/app-v013.css";      /* v0.13，新页面 */
@import "./styles/app-v30.css";       /* v3.0 底座，必须排最后 */
```

## v3.0 底座（2026-11-24，`#443` 第 0 步）

五批页面改造（#431–#435）的共同前置。**这一节写给下一批人看，不用读 CSS 也能上手。**

### 新增了什么

| 类 / 变量 | 用途 | 谁会用 |
|---|---|---|
| `.list-card` | 列表卡容器。非 `data-state="filled"` 时自动收起页脚分页 | 五批的列表页（单据 5 页、库存 3 页、主数据 4 页、操作日志、公司管理） |
| `.tf` | 列表卡页脚条：左「共 N 条 · 合计」，右分页 | 同上 |
| `.tf .pager` | 页脚内分页右对齐 | 同上 |
| `.pager button.on` / `.per` / `.dots` / `svg` | v3.0 分页的选中页、每页条数、省略号、箭头尺寸 | 同上 |
| `.tw` / `.tw.tight` | 表格横向滚动容器 / 紧凑列内边距 | 列多的单据表 |
| `.lg-*` | 登录页整套：`lg-wrap` `lg-brand` `lg-mark` `lg-slogan` `lg-sub` `lg-foot` `lg-formpane` `lg-form` `lg-hint` `lg-field` `lg-code` `lg-row` `lg-submit` `lg-alert` `lg-alt` | #435 登录页 |
| `.ent-*` / `.lg-ok` | 入企页：`ent-wrap` `ent-brand` `ent-pane` `ent-card` `ent-co` + 成功条 | #435 入企页 |
| `--v30-*` | 变量桥接，见下 | 上述类内部用 |

### 变量怎么用

`app-v30.css` 不定义新的配色，只做「v3.0 名字 → v0.13 令牌」的映射，暗色/亮色自动跟随：

```css
--v30-bg: var(--bg-0);
--v30-surface: var(--bg-2);        /* 卡片底 */
--v30-surface-2: var(--surf-2);
--v30-line: var(--line-1);  --v30-line-2: var(--line-2);
--v30-ink: var(--text-1);   --v30-ink-2: var(--text-2);   --v30-ink-3: var(--text-3);
--v30-accent: var(--accent-light);        /* 描边 / 文字强调 */
--v30-accent-solid: var(--accent-deep);   /* 实心按钮底，配 --v30-on-accent */
--v30-bad: var(--danger-on-surface);
--v30-ok: var(--ok);
```

**写新页面时用 `var(--v30-*)` 或 `var(--text-1)` 都行，别写死颜色。**

### 图标怎么用

```tsx
import { Icon } from '@/components/icons/Icon';

<Icon name="pencil" />                        // 18px，跟随 currentColor
<Icon name="refresh" size={14} className="spin" />
<button aria-label="删除"><Icon name="trash" /></button>
```

- 名字全集是 `IconName` 联合类型，编辑器会补全；`ICON_NAMES` 可做数量断言。
- **当前 23 枚**：`pg-first` `pg-prev` `pg-next` `pg-last` `clock` `trend` `trash` `pencil` `key` `shield` `refresh` `calendar` `filter` `arrow-in` `arrow-out` `adjust` `ticket` `check` `undo` `copy` `star` `pin` `split`。
- issue 标题写「24 枚」，但对照稿 §五 表格只有 23 行带 path；第 24 枚（候选 `search`）在 **#445** 待拍板。补一枚只需往 `ICONS` 加一行，调用方不用改。
- 不引图标库、不内联手写 `<path>`——这一条是 #443 的硬边界。

### 没有搬什么（以及为什么）

| 没搬 | 原因 |
|---|---|
| 外壳布局 `.app` `.sb` `.nav` `.top` `.page` `.ph` `.acts` | repo 已有 `shell` / `sidebar` / `main` / `topbar` / `wrap` / `p-head`，五批页面沿用后者，两套并存会打架 |
| `.card` `.btn` `.chip` `.kpi` `.pager` 本体 | `app-v013.css` 已定义，只在缺子元素时补 |
| 四态 `.st-block/.st-tr/.st-ico/.st-title/.st-desc/.st-actions` | `app-v013.css:38–70` 是权威版本。**稿子的 `.st-ico` 是 54px、repo 是 96px**，同名同权重，两套并存会被后加载的覆盖 |
| `.state` / `.ico`（稿子面板空态） | 同上，用 repo 的 `.st-box` + `.st-ico` |
| 全局 reset 与米白色板 `#f5f4f0` / 朱砂 `#dc4a26` | 会砸现有页面；按 #443「颜色以 tokens-v013 为准」，只用映射后的变量 |
| `@media print` 打印客户联 | 属第一批单据页（#431），单独提 |
| 原型演示外壳 `lg-ver` `lg-theme` `lg-mock` | 与 `.phone` / `.stage` 同类：版本水印、「切换亮暗」浮钮、「模拟登录失败 / 演示口令」提示。只服务设计稿自身演示，产品页面不会出现 |

### 五批页面怎么接这个底座

| 批次 | 接哪几样 | 别做 |
|---|---|---|
| 第一批 #431（单据 5 + 冲正） | `.list-card` + `.tw` + `.tf` 页脚分页、`.tf .pager` 子元素、`Icon` | 别自己写分页控件；别把 `.st-*` 在这层重定义 |
| 第二批 #432（主数据 4 + 员工） | 同上（列表形态完全一致） | 同上 |
| 第三批 #433（库存 3） | `.list-card` + `.tf`；KPI 继续用 v0.13 的 `.kpis` / `.kpi` | 别用稿子的 `.state` / `.ico` |
| 第四批 #434（设置组 6） | `.panel` + `.st-block`（面板型四态，v0.13 已有）+ `Icon` | 别改 `.panel` 本体 |
| 第五批 #435（登录 / 入企 / 工作台） | `.lg-*`（登录）、`.ent-*` + `.lg-ok`（入企）、`.panel`（工作台） | `.lg-ver` / `.lg-theme` / `.lg-mock` 是演示外壳，不接 |

接的时候先读下面「四态怎么用」两段（块级 / 表格），**四态的 DOM 结构是硬约定**，改结构就会掉进 `list-state.ts:6-11` 点名的坑。

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
