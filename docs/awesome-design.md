# 轻单 · UI 设计资源清单（awesome-design）

> **UI 视觉真源配套**：本文件登记 `apps/web` 的视觉语言与外部参考资源，供 UI（赖皓妍）与后续页面实装对齐。
> 视觉口径变化时先改这里的「本项目视觉语言」，再动代码；与 `docs/decisions.md` 冲突时以后者为准。

## 本项目视觉语言（2026-11-06 起生效）

| 维度 | 口径 | 落点 |
|---|---|---|
| 风格 | **黑白简约现代**：全站零彩色，只用 slate 黑白灰阶 | `apps/web/src/**` |
| 毛玻璃 | 登录卡片 `bg-white/70 + backdrop-blur-2xl + border-white/60`，背景黑白灰光斑透出层次 | `LoginPage.tsx` |
| 主色 | 纯黑 `slate-950`（按钮/Logo/强调）、`slate-100` 底、白色卡片 | `LoginPage.tsx` |
| 圆角 | 卡片 `rounded-2xl`、输入框/按钮 `rounded-xl`、胶囊 `rounded-full` | 登录页/占位页 |
| 错误态 | **黑白化警示**：服务端错误块黑底白字（`bg-slate-950`），输入错误描边 `border-slate-900`；不用红色 | `LoginPage.tsx` |
| 字距 | Logo/按钮 `tracking-widest` 级别，标题 `tracking-tight`，正文默认 | 登录页 |
| 过渡 | 交互元素统一 `transition-colors`；focus 用黑色描边 + 低透明度环 | 表单控件 |
| 待实现徽章 | 黑白描边胶囊（`border-slate-300 + text-slate-600`），不用彩色底 | `PlaceholderPage.tsx` |

**浏览器基线约束（D56）**：毛玻璃核心 `backdrop-filter` 需要 Chromium 76+，项目基线 Chrome/Edge **111** 满足；不支持「兼容模式」浏览器——360/QQ 浏览器须切极速模式。**不要为旧内核加渐退方案**（基线之外不支持）。

## 参考资源

| 资源 | 链接 | 用途 |
|---|---|---|
| Tailwind CSS 官方文档 | <https://tailwindcss.com/docs> | 所有工具类的真源（项目用 Tailwind 4） |
| `backdrop-filter`（MDN） | <https://developer.mozilla.org/docs/Web/CSS/backdrop-filter> | 毛玻璃实现原理与兼容性 |
| `backdrop-filter` Can I use | <https://caniuse.com/css-backdrop-filter> | 对照 D56 基线核可用性 |
| Refactoring UI | <https://www.refactoringui.com> | 黑白起步、层次先行、间距系统的方法论 |
| Rauno Freiberg · Craft | <https://rauno.me/craft> | 交互细节（过渡、focus、微动效）参考 |
| Tailwind Play | <https://play.tailwindcss.com> | 离线调样式草稿，验证后再进仓库 |
| 原型 IA 真源 | `docs/prototype-v0.md` §2 | 22 页信息架构，视觉不可改变 IA |
| 口径真源 | `docs/decisions.md` | 视觉与交互冲突时以其为准 |

## 外部资源精选（自 awesome-design 社区清单，2026-11-06）

> 精选自 [oscarotero/awesome-design](https://github.com/oscarotero/awesome-design) 与 [brandonhimpfen/awesome-design](https://github.com/brandonhimpfen/awesome-design)（本地克隆在仓库外 `references/`），只收与本项目 Web UI 直接相关的条目。

**图标（与 Tailwind 风格最搭的排前）**

| 资源 | 链接 | 说明 |
|---|---|---|
| Heroicons | <https://heroicons.com> | Tailwind 官方团队出品，线条风格与本项目黑白简约天然一致，**首选** |
| Tabler Icons | <https://tabler.io/icons> | 3000+ MIT SVG，笔画风格统一，备选 |
| Phosphor | <https://phosphoricons.com> | 六档粗细可调，适合需要轻重层次的界面 |
| Icônes | <https://icones.js.org> | 主流图标集聚合浏览器，找图标先来这里搜 |

**字体（黑白简约 + 中英混排场景）**

| 资源 | 链接 | 说明 |
|---|---|---|
| Inter | <https://rsms.me/inter/> | 黑白 UI 事实标准西文字体；本项目中文为主走系统字体栈，西文可回落 Inter |
| Mona Sans & Hubot Sans | <https://github.com/github/mona-sans> | GitHub 出品变量字体，与代码仓气质契合 |
| Atkinson Hyperlegible | <https://www.brailleinstitute.org/freefont/> | 低视力友好，无障碍场景参考 |
| 字体落地约束 | — | **先看 D56 基线**：老机器无网络字体加载预算，优先系统字体栈；引入 web font 须先拍板 |

**设计规范与灵感**

| 资源 | 链接 | 说明 |
|---|---|---|
| Laws of UX | <https://lawsofux.com> | 心理学原则（希克定律/接近原则等），页面布局自查 |
| NN/g UX Guidelines | <https://www.nngroup.com/articles/ux-guidelines/> | 研究型 UX 准则 |
| Checklist Design | <https://www.checklist.design> | 页面/组件完备性检查单，实装前过一遍 |
| Mobbin | <https://mobbin.com> | 真实产品 UI 模式库，找黑白灰实现案例 |
| Design Systems Repo | <https://designsystemsrepo.com> | 公开设计系统聚合，定规范时参考 |
| Awwwards / Land-book | <https://www.awwwards.com> / <https://land-book.com> | 黑白极简风格灵感检索 |

**对比度与可访问性（黑白设计的生命线）**

| 资源 | 链接 | 说明 |
|---|---|---|
| 交互式色彩与对比度指南 | <https://www.joshwcomeau.com/css/interactive-guide-to-color-and-contrast/> | 灰阶层次与对比度原理，黑白风格必读 |
| Neurodiversity Design System | <https://neurodiversity.design> | 认知多样性设计准则 |

**工具**

| 资源 | 链接 | 说明 |
|---|---|---|
| Figma | <https://figma.com> | 视觉稿主工具 |
| Penpot | <https://penpot.app> | 开源替代，涉密稿可用 |

## 约定

1. **新增页面实装前**先对齐上表视觉语言，不确定的先在本文件追加一行口径再写代码。
2. **禁止引入彩色**（含图表配色）；将来数据可视化如需红涨绿跌（中国行情惯例），届时单独拍板进 `decisions.md`。
3. 毛玻璃只用于**浮层/卡片**级（登录卡、将来的弹窗/抽屉），页面主背景保持 `slate-100` 纯色，避免整屏模糊的性能开销。
