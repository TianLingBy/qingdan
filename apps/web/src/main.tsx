import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/*
 * 主题默认值（v3.0 底座配套）。
 *
 * `apps/web/src/styles/tokens-v013.css` 的默认口径是暗色（`:root`），浅色只写在
 * `html[data-mode="light"]` 下；而当前产品外壳是浅色布局。不写这一行，v3.0 页面会
 * 出现「白底 + 浅色字」。整个仓库此前没有任何地方写 `data-mode`，所以在这里定一次，
 * 各页不要再各自设置（重复设置会在将来接主题开关时互相覆盖）。
 */
document.documentElement.dataset.mode = 'light';

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
