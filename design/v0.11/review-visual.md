# 美感审查 · visual-reviewer

## 结论

25 屏里同时活着两套皮肤：8 屏吃到 visual.css 的 25px 标题 / 14px 卡片 / 28px KPI，14 屏还在跑各自内联复刻的 page.css（22px / 12px / 24px），客户翻三页就能看出同一个组件换了个人做。暗色四层表面实测只有 **1.06:1** 的差（卡片 #121613 vs 页面 #0A0E0C），卡片"浮起来"全靠一条 12% 的边，而状态色只有绿和红、没有 warn，于是"草稿"和"已入库"同色。最伤第一印象的两处是侧栏 22 个一模一样的占位方块图标，和一张名叫「业务全流程图」、实际是 4 列表格的页面——它们直接把稿子拉到"框架跑通了、还没画完"的档位。

---

## 最像半成品的三屏

### 1. 业务全流程图.html（最严重）

**为什么**：页面名承诺一张图，画面是一张 4 列 5 行的普通表格，没有任何节点、连线、方向、泳道——除了 `<h1>` 之外没有一处图形语言；更糟的是第三列表头直接写着「**还缺什么**」，把内部待办清单摆给客户看（"到货数量差异的二次确认""提成规则配置"）。同一种"文案说 A、画面是 B"的落差在 `权限设置.html` 重复了一次：副标题写"权限是矩阵，不是开关"，落地却是 5 列 3 行的列表。

**怎么改**：
- 真做成图：5 个节点横向排 + 箭头 + 每节点 3 行状态（谁开单 / 谁确认 / 钱货在哪一步对上），SVG 或 `grid` 都行，节点圆角用 `--r-card` 12px。
- 表格若要保留，砍到 3 列（单据 / 已能做什么 / 页面），把「还缺什么」整列移出客户可见版本。
- `.p-head h1` 补到 25px，与 8 个 visual.css 页面一致（现在是 22px）。

### 2. 配色对比.html

**为什么**：它其实不是产品界面，是一张开发期的色卡草稿，却被放在交付目录里当一屏。
1. 自带一套硬编码色值，而且**与 tokens.css 不一致**：A 套写 `--bg0:#0F1114`，tokens.css 的 mist 是 `#0A0D11`；B 套写 `--acLt:#AEC7B6`，tokens 是 `--accent-light:#B6D0BE`。客户拿这页对色会拿到两套答案。
2. 字体栈是 `system-ui,-apple-system,"Segoe UI","Microsoft YaHei"`，**没有加载 fonts.css、没有文楷**——四套小样和真机截图不是同一套字。
3. 最小字号 **8.5px**（`th`、`.kpi .k`）、`td` 12px、`.pill` 10px，投到会议室屏幕上表头直接是灰线。

**怎么改**：色值全部换成 `var(--bg-0)`…`var(--accent-light)` 引用（它本来就是给客户选色的页）；字号下限抬到 11px（表头 11 / 正文 12）；或者把这一页挪进 `docs/`，不进客户包。

### 3. 工作台.html

**为什么**：这是客户第一眼看到的屏，但视觉权重是反的。
- 问候语 `.hero-h` **28px / 680**，hero 块 132px 高，占了首屏最贵的位置；而真正要处理的事只有 3 行。
- 20 个入口卡（`.entries` 6 列 × 4 行、单卡 `minmax(158px,1fr)`、约 96px 高）合计 **≈414px，占 1440×1000 截图的 44%**，视觉面积是「等我处理」卡的 1.6 倍。首屏最重的色块是最不需要看的东西。
- KPI 数字只有 **24px**（内联 `.kpi b{font-size:24px}` 覆盖了 visual.css 的 28px），比 hero 标题小 4px——"关键数字"比"下午好"还轻。
- hero 副文案 `max-width:60ch` 在 1440 宽下断成"…今天的单基本收 / 尾，剩下的…"，一个词被拆两行（截图 y≈190-235）。

**怎么改**：`.hero-h` 降到 22px、副文案收到 46ch + line-height 1.6；`.kpi b` 回到 28px；20 个入口压成一行横向 chip（或收进侧栏"全部页面"），首屏只留 3 条待办 + 3 个 KPI。

---

## 具体问题清单

### P0（破坏系统一致性，客户一眼可见）

- `[操作日志.html / 内联 <style> 第 16 行 · 共 14 页]` 两套皮肤并存 | 14 个页面把 page.css 整段内联复刻（`.sidebar{width:236px…}`、`.p-head h1{font-size:22px}`、`.card{…border-radius:12px}`、`tbody td{padding:11px 14px}`），且**不加载** visual.css / polish.css / ui.css；只有 8 页加载。同一元素在采购单A.html 是 25px / 14px / `12px 16px`。右下角 ◐ 设置坞也只在 9 屏出现（ui.js 未加载） | 删掉这 14 页的内联副本，全部走 page.css + visual.css；以后只改共享层；工作台还要删掉自己那层 `<style>` 覆盖（`.kpi b` 24px、`.card` 12px）
- `[tokens.css / --surf-1 与 visual.css .card]` 暗色四层表面塌成一层 | `.card` 背景是 `linear-gradient(180deg, var(--surf-1), …)`，`--surf-1:rgba(233,231,224,.035)` 叠在 `--bg-0:#0A0E0C` 上得 **#121613**，两者对比度 **1.06:1**；`--sh-1:0 10px 28px -12px rgba(0,0,0,.68)` 在近黑底上不可见。四层（bg-0 / surf-1 / surf-2 / 控件）实际读成"一块底 + 几条 1px 边" | 卡片改用 `--bg-2:#1A211C`（1.19:1）或把 surf-1 抬到 6–7%；阴影换成 `inset 0 1px 0 rgba(255,255,255,.06)` + `border:1px solid var(--line-1)`，别指望黑投影
- `[tokens.css / 缺 --warn；采购单A.html / .st.warn 与 .st.ok]` 状态色只有绿和红，没有中间档 | tokens.css 只定义 `--ok:#9CCBAE`、`--danger:#C0533A`；`.st.warn` 借用 `--accent-light:#B6D0BE`，与 `--ok` 色相 140° vs 141°、亮度差 4%，"待供应商确认"与"已入库"在暗底上几乎同色；"草稿"也用 `.warn`，于是**最没开始的状态反而带强调色** | 新增 `--warn:#D9A75B`（或 12° 暖橙），三态色相间距 ≥60°；`.st.warn` 不再引用 accent；并把采购单A A-0020 的 `<span class="st ok">已取消</span>` 改成 `.st.cancel`（虚线边 + text-3），取消态不该是绿的
- `[nav.js / ICON 常量]` 侧栏 22 个图标全是同一个占位方块 | `'<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>'` 被所有导航项共用，渲染出来就是一行「□ 登录/入企」「□ 工作台」（工作台.png y≈95-215 可见），14×14px、`opacity:.55` | 按 8 个域给 8 个线稿图标（单据=纸、库存=箱、报表=柱），或者干脆去掉图标只留文字——留占位方块比没有更糟

### P1（影响可读性 / 扫读效率）

- `[fonts.css / --sans 回落链]` 文楷靠两个 CDN，离线必塌 | 第 2–3 行 `@import url("https://cdn.jsdelivr.net/…")` + `unpkg`；回落链是 `"LXGW WenKai"…,"KaiTi","楷体","SimKai",-apple-system,"PingFang SC","Microsoft YaHei"`——**楷体排在黑体前面**。内网/断网演示时，12.5px 楷体在 `#0A0E0C` 上笔画断裂 | 数据层直接用 `system-ui,"Microsoft YaHei"`；文楷只留 H1 / hero / 空态标题；字体文件本地化，别放关键渲染路径
- `[tokens.css / --fs-* 与全站硬编码]` 字号阶梯是摆设 | `--fs-9:10px / --fs-10:11px / --fs-11:12px / --fs-12:12px`（名字与值错位、两档重复），全站 `var(--fs-` 引用次数 **0**；实际硬编码 **24 个**字号：8.5 / 9 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 12.8 / 13 / 13.5 / 14 / 15 / 17 / 19 / 22 / 24 / 25 / 26 / 28…；表格正文三档并存（page.css 12.5、visual.css 12.8、单据详情 13），body line-height 1.65 / 1.7 / 1.72 三档 | 收敛成 6 档（11 / 12 / 13 / 15 / 22 / 28）并全部改成 var()；表格正文固定 13px、line-height 1.6
- `[结算单C.html / <th data-sort>总售价</th> 与 <td class="num">]` 表头与数据分居两端 | `总售价` `总成本` 的 `th` 没有 `.num`（左对齐），单元格有 `.num`（右对齐 + mono），¥336,000 贴右、表头贴左，同列两端分裂；加工单B.html 的「加工费」同病 | th 与 td 同时加 `.num`；或写 `th:has(+…)` 不如直接补 class，最稳
- `[采购单A.html / <td class="num">12,000 千克</td>]` 单位塞进等宽数字单元 | `.num` 强制 `var(--mono)`，中文"千克 / 件 / 箱"回落系统字体，右对齐时单位宽度不同 → 六行的数字起始位不齐（截图 x≈790-880 可见） | 拆成 `<span class="n">12,000</span><span class="u">千克</span>`，单位固定 2em 左对齐；或独立单位列
- `[采购单A.html / <td>A-0024</td>、<td>11-10</td>]` 单号与日期没走等宽 | 单号、日期单元格没有 `.num` / `.mono`，走文楷比例字；`.card tbody td:first-child{font-variant-numeric:tabular-nums}` 对比例字体无效；components.css 里定义了 `.date{font-family:var(--mono)}` 但全站 `class="date"` 使用次数 **0** | 单号 / 日期统一 `.mono`；日期列右对齐；删掉没被使用的 `.date` 或真的用起来
- `[采购单A.html / .sec 单据类型]` 首屏密度：过滤器抢了表格的位置 | 可收起的「单据类型」区 96px 高 + 工具栏 40px，表格首行落在 y≈433（1440×900 截图），**从页面顶部算占 48%**；这个区块有边框 + 底色 + 标题，视觉权重与主表格卡片同级 | 降级成工具栏里一行 chip（总高 ≤36px）或一个下拉；默认收起时只留 28px 摘要行
- `[visual.css .card / 登录页 .card-login / tokens.css --r-*]` 圆角语言 14 种 | 全站出现 `3 4 5 6 7 8 9 10 11 12 14 16 20 999` 十四种圆角：`--r-card:12` `--r-panel:14` `--r-control:7` `--r-tag:5`，而 page.css 用 8/9/12、visual 用 14、工作台 hero 用 16、登录卡用 **20**、配色对比小样用 3/4/6/7 | 收敛成 4 档：控件 6 / 卡片 12 / 面板 16 / 胶囊 999；登录卡 16 而不是 20
- `[page.css .wrap / visual.css .p-head / .kpis]` 竖向节拍不齐 | 页边距 26px，页头下 20px（visual）但内联页是 16px，卡片内 4 档（16×18 / 14×16 / 12×16 / 11×14），KPI 间距 14px vs 12px，说明上 12px；首屏出现 26 / 22 / 20 / 18 / 16 / 14 / 12 / 10 八种竖向值，其中 26、22、18 都不是 4 的倍数 | 全站 8pt 栅格：页边距 24，页头下 16，卡片内 16 / 20，卡片间距 16；只保留 4 的倍数
- `[ui.css 转场 + visual.css rise + polish.css .card rise]` 一次点击叠 4 层动效 | 点侧栏链接：`.qd-leaving` opacity .12s → 110ms 后跳转 → 新页 `.main` `qdFade .18s` → `.card` `rise .32s` → `[data-reveal]` 240ms + 30ms 递进；另外 `.eyebrow::before` 是 `animation:glow 2.6s ease-in-out infinite`（每个页头一颗永远呼吸的点），`.sb-link:hover{transform:translateX(2px)}` 与 `.row:hover{translateX(2px)}`、`.entry:hover{translateY(-2px)}` 三种位移方向 | 入场只留一层（`.main` 180ms），删 `.card rise` 与无限 glow；hover 只用 `background/border-color`，不做位移
- `[tokens.css / --text-decor 与 .foot]` 3.5:1 的"装饰色"用在信息上 | `--text-decor` 实测在 bg-0 上 **3.51:1**、在 bg-2 上 **3.46:1**，但被用于页脚 11.5px、侧栏分组名 11px、时间轴时间 11.5px、入口卡序号 10.5px；`--danger:#C0533A` 在暗底 **4.2:1**，正是 `.st.bad` 的文字色（详情页反而用 6.95:1 的 `--danger-on-surface`，同一个"危险"两种红） | 信息文字一律 `--text-3`（5.9:1）；`.st.bad` 改用 `--danger-on-surface`；`--text-decor` 只留分隔符
- `[登录页.html / .hint、.f input::placeholder]` 小字对比度双不达标 | `.hint` 是 `rgba(255,255,255,.42)` + `font-size:11.5px`，叠在 `rgba(255,255,255,.085)` 卡面上实测 **3.79:1**；placeholder `.34` → **2.98:1**；`.f label` 11.5px、`.foot` 11px，全低于 components.css 自己写的"12px 下限" | hint 提到 .6、placeholder .48、字号 12px；label 12px
- `[ui.css / html[data-mode="dark"]{--text-3:#98A5A0}]` 亮暗覆盖打死主题色 | 四套主题各自的 `--text-3` 被一条固定灰覆盖：bronze 的暖灰（239,234,225 × .62）变成冷灰 #98A5A0；light 模式强制 `#6C7770`，在 `#F6F4EF` 上只有 **4.24:1**，低于 AA 4.5，也与 tokens.css 注释宣称的"≥6:1"不符（paper 主题自己的 .64 也只有 4.3:1） | 删掉这两条全局覆盖，改在各主题块内定值；paper / light 的 text-3 压到 rgba(30,29,26,.78)
- `[单据详情.html / <style> 在 components.css 之前]` 共享层反向覆盖页内设计 | 页内 `<style>` 写在 `<link components.css>` 前面，于是 components.css 的 `thead th{position:sticky;top:var(--topbar-h);background:var(--bg-0)}` 盖掉页内 `thead th{background:var(--bg-2)}`——`#0A0E0C` 的表头条嵌在 `#1A211C` 的卡片里，露出一条更黑的横带；同时被加上 `tbody tr:nth-child(even){background:var(--surf-1)}` 斑马纹 | 把 components.css 放回 `<style>` 之前；或在页内把 `thead th` 提到 `.card thead th` 权重
- `[page.css .st / 单据详情 inline .st / 工作台 .st]` 同一个"状态"三套长相 | 列表页：h22 / radius 999 / **1px 实色 `--ok` 描边 / 无圆点 / 11.5px**；详情页：h22 / `--line-2` 描边 / **5px 圆点** / 11px（又被 components 顶到 12px）；工作台：h22 / 无底色 / 11.5px。实色描边还让状态标签比主按钮更抢眼（全站边框是 12% 透明度） | 抽一个 `.st` 基类（h22 / radius 999 / line-2 描边 / 11.5px）+ 圆点开关 + 3 个语义色；描边用 `color-mix` 30% 而不是 100%

### P2（打磨）

- `[components.css .eyebrow::before 与 visual.css .eyebrow::before]` 同一伪元素两处定义、两种样子 | components 写 `content:"// "`（mono / 10px / letter-spacing .18em），visual 又写成 `content:"";width:5px;height:5px;border-radius:50%` + 呼吸动画。结果 14 页显示「// 权限设置 · 功能域 × 动作」，8 页显示「● 工作台 · 按角色」——眉标在两种形态间跳 | 只保留圆点一处，删掉 `content:"// "`；`letter-spacing` 从 .18em 收到 .08em
- `[登录页.html / .foot]` 版本号与全站不一致 | 页脚写「轻单 **v0.10** · 设计稿 · 演示数据」，其余 24 屏写「轻单 **v0.11**」；登录卡 392px 宽 + 20px 圆角也自成一套 | 统一 v0.11、圆角 16px

---

## 做对了的地方

1. **数字列真的等宽了**：`.num,.mono{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}` + `td.num{text-align:right}` 是一条被贯彻到底的规则——采购单A 的 ¥86,400 / ¥32,800 / ¥54,100 个位对齐，扫一列金额不跳行。这条比任何装饰都值钱。
2. **页头只给一个强调点**：`.p-head::after` 的 56px × 2px 渐变下划线（`linear-gradient(90deg,var(--accent),transparent)`）给每页标题一个固定起点，且全页只有这一处用 accent 描边——标题、主按钮、下划线三者的强调预算没有打架。
3. **动效有时长分级，也真的关得掉**：`--d-1:110ms`（交互）/ `--d-4:240ms`（入场）/ `--d-data:420ms`（数据）分层清楚，`@media(prefers-reduced-motion:reduce)` 把 shimmer、reveal、glow、veil、aura 全部关掉——这是 25 页里最容易漏的一层，却做到了。
4. **语义 token 是一处改全站**：四套主题只在 tokens.css 里换色相，页面零裸色（除配色对比页）；切 moss→bronze 时 `.sb-mark`、主按钮、焦点环、选中态一起变，没有残留的旧金色。
5. **热区与视觉尺寸解耦**：`.bar .btn{height:34px;min-height:44px}`、`.cb::before{width:32px;height:32px}` 让按钮看着是 34px、点得到 44px——B 端表格里最容易被牺牲的一条，这稿保住了。

---

## 一条最重要的建议

**先删掉那 14 个页面里的内联 page.css 副本，让 visual.css 成为唯一的材质来源。** 现在 H1 22/25、KPI 24/28、卡片圆角 12/14、表格行距 11×14/12×16 这些差值，全部来自"同一份样式被复制了 14 次又被各自改了一点"；不先合并这一层，后面每调一次圆角、字号、间距，都要在 14 个文件里找同样的字符串，而客户只要连翻三页就能看出前后不是一套东西。合并之后，把省下的预算花在两件事上：给状态色补一个真正的 `--warn`，以及把文楷从数据层撤到展示层。
