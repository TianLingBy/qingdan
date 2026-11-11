# 设计令牌（UI Tokens）· v0.8

> 来源：`design/v0.8/` 的设计稿（静态原型），落地点：`apps/web/src/styles/tokens.css`
> 接入方式：`apps/web/src/index.css` 第 3 行 `@import "./styles/tokens.css";`

---

## 一、这套令牌解决什么问题

页面里现在还有大量裸色（`slate-500`、`emerald-50`、`amber-100`…），同一个语义在各页写法不同。
令牌只做一件事：**给语义起名字**，颜色值只允许出现在 `tokens.css` 里。

改配色只改 `:root` 或 `[data-theme]` 块，页面与组件零改动。

---

## 二、四套主题

| 主题 | 触发 | 主色 | 场景 |
|---|---|---|---|
| **moss**（默认） | 不写 `data-theme` | 苔绿 `#93AE9C` | 深色内页 |
| mist | `data-theme="mist"` | 雾蓝 `#8FA9BE` | 深色内页（备选） |
| bronze | `data-theme="bronze"` | 古铜 `#C4A57B` | 深色内页（备选） |
| paper | `data-theme="paper"` | 松烟青 `#3E5B50` | 浅色内页 / 打印 |

登录页封面恒为深色，只有强调色跟随主题。

---

## 三、Token 对照表

### 表面（背景）——亮度差 8~12%，卡片才浮得起来

| Token | 工具类 | 用途 |
|---|---|---|
| `--color-surface-0` | `bg-surface-0` | 视口底色 |
| `--color-surface-1` | `bg-surface-1` | 侧栏、次级面板 |
| `--color-surface-2` | `bg-surface-2` | 卡片、表格容器 |
| `--color-surface-3` | `bg-surface-3` | 输入框、悬浮层 |
| `--color-surface-4` | `bg-surface-4` | hover / 弹层 |

### 文字

| Token | 工具类 | 对比度 | 用途 |
|---|---|---|---|
| `--color-ink-1` | `text-ink-1` | ≈14:1 | 主文字、标题、金额 |
| `--color-ink-2` | `text-ink-2` | ≈9:1 | 次级文字、表头 |
| `--color-ink-3` | `text-ink-3` | ≈6:1（AA） | 说明、辅助信息 |
| `--color-ink-decor` | `text-ink-decor` | ≈3.3:1 | **仅装饰**：眉标、分隔符，不承载信息 |

### 强调与状态

| Token | 工具类 | 规则 |
|---|---|---|
| `--color-accent` | `text-accent` `border-accent` | 激活态、图表主线、关键金额 |
| `--color-accent-deep` | `bg-accent-deep` | **每屏一个**实心主操作 |
| `--color-accent-light` | `text-accent-light` | 深底上的强调文字 |
| `--color-on-accent` | `text-on-accent` | 强调实底上的文字（深墨） |
| `--color-ok` | `text-ok` | 已完成、成功 |
| `--color-danger` | `text-danger` `border-danger` | **仅删除 / 负金额** |
| `--color-danger-on-surface` | `text-danger-on-surface` | 深底上的危险文字 |

### 描边

| Token | 工具类 | 用途 |
|---|---|---|
| `--color-line-1` | `border-line-1` | 分隔线、表格行 |
| `--color-line-2` | `border-line-2` | 卡片边框 |
| `--color-line-3` | `border-line-3` | hover / 强描边 |

### 几何与字号

| Token | 工具类 | 值 |
|---|---|---|
| `--radius-control` | `rounded-control` | 7px（按钮、输入框） |
| `--radius-card` | `rounded-card` | 12px |
| `--radius-panel` | `rounded-panel` | 14px |
| `--radius-tag` | `rounded-tag` | 5px |
| `--radius-pill` | `rounded-pill` | 999px |
| `--text-min` | `text-min` | 12px（**信息性文字下限**） |
| `--text-body` | `text-body` | 14px |
| `--text-label` | `text-label` | 12px |
| `--text-title` | `text-title` | 22px |
| `--text-display` | `text-display` | 30px |

### 动效

| Token | 值 | 用途 |
|---|---|---|
| `--d-1` / `--d-2` | 110ms / 160ms | hover、按压、常规反馈 |
| `--d-3` / `--d-4` | 200ms / 240ms | 抽屉、入场 |
| `--d-data` | 420ms | 图表生长 |
| `--ease-enter` | `cubic-bezier(.16,1,.3,1)` | 进场 |
| `--ease-exit` | `cubic-bezier(.7,0,.2,1)` | 退出 |
| `--ease-loop` | `cubic-bezier(.65,0,.35,1)` | 循环 |

> 原则：**交互反馈 ≤160ms，入场 240ms**，B 端高频操作优先瞬时响应。
> `prefers-reduced-motion` 时全部关闭（已在 `tokens.css` 兜底）。

---

## 四、怎么用

```tsx
// 卡片
<section className="bg-surface-2 border border-line-2 rounded-card shadow-card">

  {/* 表头用中性色，中文不用 mono、不用大写 */}
  <thead className="text-ink-3 text-label">…</thead>

  {/* 金额：等宽数字 + 右对齐；无看价权限时是 "—"，不回落成 0（D79） */}
  <td className="font-mono text-right tabular-nums text-ink-1">{amount ?? '—'}</td>

  {/* 每屏一个实心主操作 */}
  <button className="bg-accent-deep text-on-accent rounded-control hover:bg-accent">确认入库</button>
</section>
```

---

## 五、还没做的（下一步）

1. **页面还没换成 token**：`apps/web/src/pages/**` 里仍有大量裸色（`slate-*` 等），需要一个页面一个 PR 地换，先从新写的页面开始。
2. **组件库还没建**：`apps/web/src/components/` 仍为空（`#153`）。组件是 token 的第一批使用者。
3. **间距没进 @theme**：Tailwind v4 的 `--spacing` 是全局基准，改它会牵动全站，所以 `--sp-1..8` 先只作为 CSS 变量提供，等组件库定型再决定是否映射成工具类。
4. **浅色主题（paper）的对比度**只在设计稿里验过，换成真实页面后需要重新跑一遍对比度检查。

---

## 六、参考

- 设计稿与说明：`design/v0.8/`（含 6 个页面、配色对比、动效脚本）
- 令牌实现：`apps/web/src/styles/tokens.css`
- 浏览器基线：D56（Win10 22H2 + Edge 111 级别）
- 金额口径：D27 / D79（`null` → 占位符，不显示 0）
