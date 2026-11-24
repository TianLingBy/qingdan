# v3.0 底座自验现场（#443）

这里只有三样东西：一份不依赖 React 的 demo 页 + 两张截图。**不是产品页面，不进构建。**

| 文件 | 用途 |
|---|---|
| `demo.html` | 把 `apps/web/src/styles/app-v30.css` 的类拼一遍：`.card` vs `.card.list-card + .tf`、23 枚图标、`.panel` 四态。双击即可在浏览器打开（CSS 用相对路径引 `apps/web/src/styles/`） |
| `base-light.png` / `base-dark.png` | 上面那份 demo 在亮色 / 暗色下的渲染结果，PR 里引用的是这两张 |

## 为什么要有这个目录

`#443` 的验收要求附一张「把现有页面塞进 `.panel` 的肉眼对比截图」，并注明**不要真改任何页面**。
于是做了这份只读的 demo：左半是 v0.13 现有卡片，右半换成 `.list-card + .tf` 页脚，下面接四态面板与图标总览——
一眼能看出新底座没有把老样式砸掉（左半与 v0.13 完全一致）。

## 复现

直接用浏览器打开 `demo.html` 即可，不需要起 dev server。

亮/暗切换：把 `demo.html` 第 2 行的 `data-mode="light"` 改成 `dark`。

截图命令（Edge headless，本机验证用）：

```
msedge --headless --disable-gpu --window-size=1400,1150 --virtual-time-budget=5000 --run-all-compositor-stages-before-draw --screenshot=base-light.png docs/ui/v3.0-base/demo.html
```

## 注意

- 目录里的 `demo.html` 不是五批页面的模板，别复制它写业务页——真正的写法看 `apps/web/src/styles/README.md` 的「v3.0 底座」一节。
- 底座合并后这个目录可以留着当回归样张，也可以在五批全部落地时一并删掉，不影响任何代码。
