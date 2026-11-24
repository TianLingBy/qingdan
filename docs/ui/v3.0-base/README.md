# v3.0 底座验收证据（#443）

这里只有两张截图，**没有页面、没有代码，不进构建**。

| 文件 | 内容 |
|---|---|
| `base-light.png` | 同一段「销售单列表」内容：左边现有 v0.13 写法（`.card` 直接铺），右边塞进 v3.0 的 `.panel` + `.card.list-card` + `.tf` 页脚；底部是第二条交付物 23 枚图标 |
| `base-dark.png` | 同上，`data-mode="dark"` |

## 为什么是这两张

#443 的验收要求是「附一张把某个现有页面塞进 `.panel` 的肉眼对比截图（证明底座能用；不要真改那个页面）」。所以：

- 两侧的表格行、列、徽章**完全相同**，只多了 `.panel` 外壳与 `.tf` 页脚 —— 一眼能看出接上底座后原页面没走形；
- 用的是 `styles/README.md` §「四态怎么用 · 表格」里的示范片段，**没有改动任何真实页面**（本 PR 的 `git diff` 里 `apps/web/src/pages/**` 为 0 字节）。

## 怎么自己复现

不需要起 dev server，也不用往仓库提交 demo 文件：

```html
<!doctype html>
<html lang="zh-CN" data-mode="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="apps/web/src/styles/tokens-v013.css">
<link rel="stylesheet" href="apps/web/src/styles/app-v013.css">
<link rel="stylesheet" href="apps/web/src/styles/app-v30.css">
</head><body>
  <!-- 左边：现有写法 -->
  <div class="card"><table>…</table></div>
  <!-- 右边：同一段内容塞进 .panel -->
  <section class="panel" data-state="filled">
    <div class="panel-h">销售单</div>
    <div class="card list-card" data-state="filled">
      <div class="tw"><table>…</table></div>
      <div class="tf"><span>共 N 条 · 合计 …</span><div class="pager">…</div></div>
    </div>
  </section>
</body></html>
```

把这段存成仓库根目录下的临时 `.html`（`href` 路径要对得上 `apps/web/src/styles/`），浏览器直接打开就是截图里的样子。改 `data-mode="dark"` 看暗色。

截图命令（本机 Edge headless）：

```powershell
msedge --headless --disable-gpu --window-size=1480,620 `
  --virtual-time-budget=6000 --run-all-compositor-stages-before-draw `
  --screenshot=base-light.png <临时 html 的 file:// 路径>
```

## 注意

- 这两张图是**证据**，不是页面模板。写业务页请对着 `apps/web/src/styles/README.md` 的「v3.0 底座」与「四态怎么用」两节抄。
- 五批全部落地后，这个目录可以整块删掉，不影响任何代码。
